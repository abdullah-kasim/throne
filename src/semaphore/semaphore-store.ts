import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  heldLocks,
  processStartTime,
  recordLockCommand,
  tryTakeLock,
  type HeldLock,
  type NamedLockRow,
} from "../shared-policy/lock-rows/lock-rows.ts";
import { fileIsMissing, readTextFileIfPresent } from "../where-i-stand/file-presence.ts";
import { isSemaphoreName } from "./semaphore-arguments.ts";

const SEMAPHORES_FOLDER_NAME = "semaphores";
const SLOT_COUNT_FILE_NAME = "slots";

export interface SlotHolder {
  readonly pid: number;
  readonly commandLine: string;
  readonly startedAt: string;
}

export interface HeldSlot {
  readonly slot: number;
  readonly holder: SlotHolder | undefined;
}

export interface TakenSlot {
  readonly slot: number;
  readonly lock: HeldLock;
}

function semaphoresDirectoryIn(throneHome: string): string {
  return path.join(throneHome, SEMAPHORES_FOLDER_NAME);
}

function semaphoreDirectoryIn(throneHome: string, name: string): string {
  return path.join(semaphoresDirectoryIn(throneHome), name);
}

function slotCountPathIn(throneHome: string, name: string): string {
  return path.join(semaphoreDirectoryIn(throneHome, name), SLOT_COUNT_FILE_NAME);
}

async function fileNamesIn(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (fileIsMissing(error)) return [];
    throw error;
  }
}

export async function writeSlotCount(throneHome: string, name: string, slots: number): Promise<void> {
  const countPath = slotCountPathIn(throneHome, name);
  await mkdir(path.dirname(countPath), { recursive: true });
  const temporaryPath = `${countPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${slots}\n`, "utf8");
  await rename(temporaryPath, countPath);
}

export async function readSlotCount(throneHome: string, name: string): Promise<number | undefined> {
  const recorded = await readTextFileIfPresent(slotCountPathIn(throneHome, name));
  return recorded === undefined ? undefined : Number(recorded.trim());
}

export async function listSemaphoreNames(throneHome: string): Promise<string[]> {
  const candidates = (await fileNamesIn(semaphoresDirectoryIn(throneHome))).filter(isSemaphoreName).sort();
  const names: string[] = [];
  for (const candidate of candidates) {
    if ((await readSlotCount(throneHome, candidate)) !== undefined) names.push(candidate);
  }
  return names;
}

function slotLockName(name: string, slot: number): string {
  return `${slotLockPrefix(name)}${slot}`;
}

function slotLockPrefix(name: string): string {
  return `semaphore/${name}/`;
}

export function takeFirstFreeSlot(throneHome: string, name: string, slots: number): TakenSlot | undefined {
  for (let slot = 1; slot <= slots; slot += 1) {
    const lock = tryTakeLock(throneHome, slotLockName(name, slot));
    if (lock !== null) return { slot, lock };
  }
  return undefined;
}

export function recordSlotHolder(taken: TakenSlot, pid: number, commandLine: string): void {
  recordLockCommand(taken.lock, { processId: pid, startedAt: processStartTime(pid), commandLine });
}

function heldSlotOf(row: NamedLockRow, prefix: string): HeldSlot {
  const holder = row.command === undefined
    ? undefined
    : { pid: row.command.processId, commandLine: row.command.commandLine, startedAt: new Date(row.takenAt).toISOString() };
  return { slot: Number(row.name.slice(prefix.length)), holder };
}

export function heldSlotsOf(throneHome: string, name: string): HeldSlot[] {
  const prefix = slotLockPrefix(name);
  return heldLocks(throneHome, prefix)
    .map((row) => heldSlotOf(row, prefix))
    .sort((left, right) => left.slot - right.slot);
}
