import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as waitFor } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runSemaphore, type SemaphoreDependencies } from "./semaphore-runtime.ts";
import { readSemaphoreStatuses } from "./semaphore-status.ts";
import type { HeldSlot } from "./semaphore-store.ts";

export const SHORT_RETRY_MILLISECONDS = 20;
const POLL_MILLISECONDS = 20;
const LONGEST_WAIT_MILLISECONDS = 5000;
const runFixturePath = fileURLToPath(new URL("./semaphore-run-fixture.ts", import.meta.url));

export interface SemaphoreRoom {
  readonly throneHome: string;
  readonly dependencies: SemaphoreDependencies;
  readonly printed: string[];
  readonly complaints: string[];
}

export async function semaphoreRoom(t: TestContext): Promise<SemaphoreRoom> {
  const directory = await mkdtemp(path.join(tmpdir(), "semaphore-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const throneHome = path.join(directory, "throne-home");
  const printed: string[] = [];
  const complaints: string[] = [];
  return {
    throneHome,
    printed,
    complaints,
    dependencies: {
      throneHome,
      retryMilliseconds: SHORT_RETRY_MILLISECONDS,
      out: (message) => void printed.push(message),
      err: (message) => void complaints.push(message),
    },
  };
}

export function semaphore(room: SemaphoreRoom, ...commandArguments: string[]): Promise<number> {
  return runSemaphore(commandArguments, room.dependencies);
}

export async function heldSlotsIn(room: SemaphoreRoom, name: string): Promise<readonly HeldSlot[]> {
  const [status] = await readSemaphoreStatuses(room.throneHome, name);
  return status?.heldSlots ?? [];
}

export async function untilHeldSlotsAre(
  room: SemaphoreRoom,
  name: string,
  isWanted: (held: readonly HeldSlot[]) => boolean,
): Promise<readonly HeldSlot[]> {
  const deadline = Date.now() + LONGEST_WAIT_MILLISECONDS;
  for (;;) {
    const held = await heldSlotsIn(room, name);
    if (isWanted(held)) return held;
    if (Date.now() > deadline) throw new Error(`the held slots of "${name}" never became as wanted: ${JSON.stringify(held)}`);
    await waitFor(POLL_MILLISECONDS);
  }
}

export function everyHolderRecorded(count: number): (held: readonly HeldSlot[]) => boolean {
  return (held) => held.length === count && held.every((slot) => slot.holder !== undefined);
}

export function stopHolderOf(held: HeldSlot): void {
  if (held.holder !== undefined) process.kill(held.holder.pid, "SIGTERM");
}

export function stopHolderWhenTestEnds(t: TestContext, held: readonly HeldSlot[]): void {
  t.after(() => {
    for (const slot of held) {
      try {
        stopHolderOf(slot);
      } catch {
        continue;
      }
    }
  });
}

export function runInAnotherProcess(t: TestContext, room: SemaphoreRoom, runArguments: readonly string[]): ChildProcess {
  const runner = spawn(
    process.execPath,
    [runFixturePath, room.throneHome, ...runArguments],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  t.after(() => void runner.kill("SIGKILL"));
  return runner;
}
