import path from "node:path";
import { and, eq } from "drizzle-orm";
import { readProcessStartTicks } from "../../process-inspection/proc-scan.ts";
import { openMigratedDatabase, type WhereIStandDatabaseHandle } from "../../where-i-stand-store/where-i-stand-database.ts";
import { RUNTIME_THRONE_ROOT } from "../runtime-throne-root.ts";
import { locks } from "./lock-rows.schema.ts";

export const LOCKS_DATABASE_FILE_NAME = "locks.sqlite3";

export const LOCK_MIGRATIONS_DIRECTORY = path.join(RUNTIME_THRONE_ROOT, "drizzle-locks");

const RETRY_INTERVAL_MS = 25;

export interface LockHolder {
  processId: number;
  startedAt: number | null;
}

export interface LockRow extends LockHolder {
  takenAt: number;
}

export interface LockCommand extends LockHolder {
  commandLine: string;
}

export interface NamedLockRow extends LockRow {
  name: string;
  command?: LockCommand;
}

export interface HeldLock extends LockRow {
  throneHome: string;
  name: string;
  takenOverFrom?: LockRow;
}

const openDatabases = new Map<string, WhereIStandDatabaseHandle>();

export function locksDatabasePath(throneHome: string): string {
  return path.join(throneHome, LOCKS_DATABASE_FILE_NAME);
}

function locksDatabase(throneHome: string): WhereIStandDatabaseHandle {
  const databasePath = locksDatabasePath(throneHome);
  let database = openDatabases.get(databasePath);
  if (database === undefined) {
    database = openMigratedDatabase(databasePath, LOCK_MIGRATIONS_DIRECTORY).database;
    openDatabases.set(databasePath, database);
  }
  return database;
}

export function processStartTime(processId: number): number | null {
  if (process.platform !== "linux") return null;
  return readProcessStartTicks(processId) ?? null;
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function holderIsAlive(holder: LockHolder): boolean {
  if (!processExists(holder.processId)) return false;
  return holder.startedAt === null || processStartTime(holder.processId) === holder.startedAt;
}

function holderOf(row: typeof locks.$inferSelect): LockRow {
  return { processId: row.holderProcessId, startedAt: row.holderStartedAt, takenAt: row.takenAt };
}

function rowIsAlive(row: typeof locks.$inferSelect): boolean {
  if (holderIsAlive(holderOf(row))) return true;
  return row.commandProcessId !== null && processExists(-row.commandProcessId);
}

export function tryTakeLock(
  throneHome: string,
  name: string,
  maximumHoldMs?: number,
  now: number = Date.now(),
): HeldLock | null {
  const holder: LockHolder = { processId: process.pid, startedAt: processStartTime(process.pid) };
  return locksDatabase(throneHome).transaction((transaction) => {
    const existing = transaction.select().from(locks).where(eq(locks.name, name)).get();
    const previous = existing === undefined ? undefined : holderOf(existing);
    const overHeld = previous !== undefined && maximumHoldMs !== undefined && now - previous.takenAt >= maximumHoldMs;
    const previousIsAlive = existing !== undefined && rowIsAlive(existing);
    if (previous !== undefined && (overHeld || !previousIsAlive)) {
      transaction.delete(locks).where(eq(locks.name, name)).run();
    }
    const inserted = transaction.insert(locks).values({
      name,
      holderProcessId: holder.processId,
      holderStartedAt: holder.startedAt,
      takenAt: now,
    }).onConflictDoNothing().run().changes;
    if (inserted !== 1) return null;
    const held: HeldLock = { throneHome, name, ...holder, takenAt: now };
    return overHeld && previousIsAlive ? { ...held, takenOverFrom: previous } : held;
  }, { behavior: "immediate" });
}

export async function waitForLock(
  throneHome: string,
  name: string,
  timeLimitMs: number,
  maximumHoldMs?: number,
): Promise<HeldLock | null> {
  const deadline = Date.now() + timeLimitMs;
  for (;;) {
    const held = tryTakeLock(throneHome, name, maximumHoldMs);
    if (held !== null || Date.now() >= deadline) return held;
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }
}

function rowOwnedBy(held: HeldLock) {
  return and(
    eq(locks.name, held.name),
    eq(locks.holderProcessId, held.processId),
    eq(locks.takenAt, held.takenAt),
    held.startedAt === null ? undefined : eq(locks.holderStartedAt, held.startedAt),
  );
}

export function releaseLock(held: HeldLock): void {
  locksDatabase(held.throneHome).delete(locks).where(rowOwnedBy(held)).run();
}

export function stillOwnsLock(held: HeldLock): boolean {
  return locksDatabase(held.throneHome).select().from(locks).where(rowOwnedBy(held)).get() !== undefined;
}

export function isLockHeld(throneHome: string, name: string): boolean {
  const row = locksDatabase(throneHome).select().from(locks).where(eq(locks.name, name)).get();
  return row !== undefined && rowIsAlive(row);
}

export function isHeldByAnother(throneHome: string, name: string): boolean {
  const row = locksDatabase(throneHome).select().from(locks).where(eq(locks.name, name)).get();
  if (row === undefined || !rowIsAlive(row)) return false;
  return row.holderProcessId !== process.pid || row.holderStartedAt !== processStartTime(process.pid);
}

export function recordLockCommand(held: HeldLock, command: LockCommand): void {
  locksDatabase(held.throneHome)
    .update(locks)
    .set({ commandProcessId: command.processId, commandStartedAt: command.startedAt, commandLine: command.commandLine })
    .where(rowOwnedBy(held))
    .run();
}

export function heldLocks(throneHome: string, namePrefix: string): NamedLockRow[] {
  return locksDatabase(throneHome)
    .select()
    .from(locks)
    .all()
    .filter((row) => row.name.startsWith(namePrefix) && rowIsAlive(row))
    .map((row) => ({
      name: row.name,
      ...holderOf(row),
      ...(row.commandProcessId === null
        ? {}
        : { command: { processId: row.commandProcessId, startedAt: row.commandStartedAt, commandLine: row.commandLine ?? "" } }),
    }));
}

export function countHeldLocks(throneHome: string, namePrefix: string): number {
  return heldLocks(throneHome, namePrefix).length;
}

export function handOverLock(held: HeldLock, processId: number): HeldLock {
  const newHolder: LockHolder = { processId, startedAt: processStartTime(processId) };
  locksDatabase(held.throneHome)
    .update(locks)
    .set({ holderProcessId: newHolder.processId, holderStartedAt: newHolder.startedAt })
    .where(rowOwnedBy(held))
    .run();
  return { ...held, ...newHolder };
}
