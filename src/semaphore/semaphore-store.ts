import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { tryExclusiveFileLock, type HeldFileLock } from "../shared-policy/exclusive-file-lock.ts";
import { fileIsMissing, readTextFileIfPresent } from "../where-i-stand/file-presence.ts";
import { isSemaphoreName } from "./semaphore-arguments.ts";

const SEMAPHORES_FOLDER_NAME = "semaphores";
const SLOT_COUNT_FILE_NAME = "slots";
const SLOT_LOCK_NAME = "semaphore slot";
const SLOT_FILE_FORM = /^slot-([1-9][0-9]*)\.lock$/;

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
  readonly lock: HeldFileLock;
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

function slotLockPathIn(throneHome: string, name: string, slot: number): string {
  return path.join(semaphoreDirectoryIn(throneHome, name), `slot-${slot}.lock`);
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

async function forgetSlotHolder(lockPath: string): Promise<void> {
  await writeFile(lockPath, "", "utf8");
}

export async function takeFirstFreeSlot(
  throneHome: string,
  name: string,
  slots: number,
  flockExecutable?: string,
): Promise<TakenSlot | undefined> {
  for (let slot = 1; slot <= slots; slot += 1) {
    const lockPath = slotLockPathIn(throneHome, name, slot);
    const lock = await tryExclusiveFileLock(lockPath, SLOT_LOCK_NAME, flockExecutable);
    if (lock !== undefined) {
      await forgetSlotHolder(lockPath);
      return { slot, lock };
    }
  }
  return undefined;
}

export async function recordSlotHolder(throneHome: string, name: string, slot: number, holder: SlotHolder): Promise<void> {
  await writeFile(slotLockPathIn(throneHome, name, slot), `${JSON.stringify(holder)}\n`, "utf8");
}

function slotHolderOf(recorded: string | undefined): SlotHolder | undefined {
  try {
    const holder = JSON.parse(recorded ?? "") as Partial<SlotHolder>;
    const isComplete =
      typeof holder.pid === "number" && typeof holder.commandLine === "string" && typeof holder.startedAt === "string";
    return isComplete ? (holder as SlotHolder) : undefined;
  } catch {
    return undefined;
  }
}

async function slotIsHeld(lockPath: string, flockExecutable?: string): Promise<boolean> {
  const probe = await tryExclusiveFileLock(lockPath, SLOT_LOCK_NAME, flockExecutable);
  await probe?.release();
  return probe === undefined;
}

export async function heldSlotsOf(throneHome: string, name: string, flockExecutable?: string): Promise<HeldSlot[]> {
  const slots = (await fileNamesIn(semaphoreDirectoryIn(throneHome, name)))
    .map((fileName) => SLOT_FILE_FORM.exec(fileName)?.[1])
    .filter((slot) => slot !== undefined)
    .map(Number)
    .sort((left, right) => left - right);
  const held: HeldSlot[] = [];
  for (const slot of slots) {
    const lockPath = slotLockPathIn(throneHome, name, slot);
    if (await slotIsHeld(lockPath, flockExecutable)) {
      held.push({ slot, holder: slotHolderOf(await readTextFileIfPresent(lockPath)) });
    }
  }
  return held;
}
