import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { findScratchDirHolders, indexClearsDirectory } from './scratch-dir-holders.ts';
import { killScratchDirHolders } from './kill-scratch-dir-holders.ts';
import {
  SCRATCH_DIR_REMOVAL_OUTCOMES,
  type ScratchDirHolder,
  type ScratchDirRemovalDependencies,
  type ScratchDirRemovalResult,
  type ScratchEntryStatus,
  type ScratchHolderIndex,
} from './tmp-scratch-lifecycle.types.ts';

const UNREADABLE_PROC: readonly ScratchDirHolder[] = [];

/**
 * Reads holders, failing safe on a total detection failure (e.g. `/proc`
 * itself unreadable). The caller must treat a non-empty `holders` result
 * OR `detectionFailed: true` as "protect this directory" — the distinct
 * flag exists so callers never mistake an undetectable state for an
 * empty, genuinely-unheld one.
 */
async function readScratchDirHolders(dirPath: string): Promise<{
  holders: readonly ScratchDirHolder[];
  detectionFailed: boolean;
}> {
  try {
    return { holders: await findScratchDirHolders(dirPath), detectionFailed: false };
  } catch {
    return { holders: UNREADABLE_PROC, detectionFailed: true };
  }
}

const SYSTEM_FOLDER_NAMES = new Set(['.X11-unix', '.ICE-unix', '.font-unix', '.XIM-unix']);
const SYSTEMD_PRIVATE_PREFIX = 'systemd-private-';

async function readRealEntryStatus(entryPath: string): Promise<ScratchEntryStatus> {
  const stats = await lstat(entryPath);
  return { ownerId: stats.uid, deviceId: stats.dev, modifiedMs: stats.mtimeMs };
}

async function removeDirectoryForGood(dirPath: string): Promise<void> {
  await rm(dirPath, { recursive: true, force: true });
}

export const REAL_SCRATCH_DIR_REMOVAL_DEPENDENCIES: ScratchDirRemovalDependencies = {
  readEntryStatus: readRealEntryStatus,
  sweepingUserId: process.getuid?.() ?? -1,
  removeDirectory: removeDirectoryForGood,
};

function isSystemFolderName(dirPath: string): boolean {
  const name = path.basename(dirPath);
  return SYSTEM_FOLDER_NAMES.has(name) || name.startsWith(SYSTEMD_PRIVATE_PREFIX);
}

function errorCodeOf(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'UNKNOWN';
}

type EntryStatusReading =
  | { kind: 'read'; status: ScratchEntryStatus }
  | { kind: 'missing' }
  | { kind: 'unreadable' };

async function readEntryStatusSafely(
  entryPath: string,
  dependencies: ScratchDirRemovalDependencies,
): Promise<EntryStatusReading> {
  try {
    return { kind: 'read', status: await dependencies.readEntryStatus(entryPath) };
  } catch (error) {
    return errorCodeOf(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };
  }
}

async function isMountPoint(
  dirPath: string,
  entry: EntryStatusReading,
  dependencies: ScratchDirRemovalDependencies,
): Promise<boolean> {
  if (entry.kind === 'unreadable') return true;
  if (entry.kind === 'missing') return false;
  const parent = await readEntryStatusSafely(path.dirname(dirPath), dependencies);
  return parent.kind !== 'read' || parent.status.deviceId !== entry.status.deviceId;
}

function isEntryTooYoung(entry: EntryStatusReading, minAgeMs: number | undefined): boolean {
  if (minAgeMs === undefined || entry.kind !== 'read') return false;
  return Date.now() - entry.status.modifiedMs <= minAgeMs;
}

export async function checkScratchDirRemovalEligibility(
  dirPath: string,
  minAgeMs?: number,
  index?: ScratchHolderIndex,
  dependencies: ScratchDirRemovalDependencies = REAL_SCRATCH_DIR_REMOVAL_DEPENDENCIES,
): Promise<ScratchDirRemovalResult> {
  if (isSystemFolderName(dirPath)) {
    return { dirPath, outcome: SCRATCH_DIR_REMOVAL_OUTCOMES.SKIPPED_SYSTEM_NAME };
  }
  const entry = await readEntryStatusSafely(dirPath, dependencies);
  if (await isMountPoint(dirPath, entry, dependencies)) {
    return { dirPath, outcome: SCRATCH_DIR_REMOVAL_OUTCOMES.SKIPPED_MOUNT_POINT };
  }
  if (entry.kind === 'read' && entry.status.ownerId !== dependencies.sweepingUserId) {
    return { dirPath, outcome: SCRATCH_DIR_REMOVAL_OUTCOMES.SKIPPED_NOT_OURS };
  }
  if (isEntryTooYoung(entry, minAgeMs)) {
    return { dirPath, outcome: SCRATCH_DIR_REMOVAL_OUTCOMES.SKIPPED_TOO_YOUNG };
  }

  if (index !== undefined) {
    return (await indexClearsDirectory(index, dirPath))
      ? { dirPath, outcome: SCRATCH_DIR_REMOVAL_OUTCOMES.REMOVED }
      : { dirPath, outcome: SCRATCH_DIR_REMOVAL_OUTCOMES.SKIPPED_LIVE };
  }

  const initialCheck = await readScratchDirHolders(dirPath);
  if (initialCheck.detectionFailed || initialCheck.holders.length > 0) {
    return { dirPath, outcome: SCRATCH_DIR_REMOVAL_OUTCOMES.SKIPPED_LIVE };
  }

  return { dirPath, outcome: SCRATCH_DIR_REMOVAL_OUTCOMES.REMOVED };
}

/**
 * Decides, then acts on, "is it safe to delete this directory": the one
 * predicate reused unmodified by reap-time cleanup and the deliberate
 * sweep. A holder present at the initial check protects the directory
 * outright — no kill is attempted against it, and it is never deleted.
 * Only a holder that races in during the narrow window between that
 * check and the delete call is killed, closing the race without ever
 * killing a holder that was already there when the caller asked.
 *
 * `preDeleteCheck` and `postKillCheck` below are always fresh,
 * unconditional `/proc` reads regardless of `index`. What differs by
 * `index` is what a `preDeleteCheck` holder is taken to mean: without an
 * index, the initial check just ran a fresh walk of its own, so any
 * holder found moments later is provably new — safe to kill as a
 * narrow-window race. With an index, the initial check trusted a
 * once-per-sweep snapshot that may be arbitrarily older than this
 * moment, so a `preDeleteCheck` holder cannot be proven to have raced in
 * — it is protected like any other pre-existing holder, never killed.
 */
export async function removeScratchDir(
  dirPath: string,
  minAgeMs?: number,
  index?: ScratchHolderIndex,
  dependencies: ScratchDirRemovalDependencies = REAL_SCRATCH_DIR_REMOVAL_DEPENDENCIES,
): Promise<ScratchDirRemovalResult> {
  const initialEligibility = await checkScratchDirRemovalEligibility(
    dirPath,
    minAgeMs,
    index,
    dependencies,
  );
  if (initialEligibility.outcome !== SCRATCH_DIR_REMOVAL_OUTCOMES.REMOVED) {
    return initialEligibility;
  }

  const preDeleteCheck = await readScratchDirHolders(dirPath);
  if (preDeleteCheck.detectionFailed) {
    return { dirPath, outcome: SCRATCH_DIR_REMOVAL_OUTCOMES.SKIPPED_LIVE };
  }
  if (preDeleteCheck.holders.length > 0) {
    if (index !== undefined) {
      return { dirPath, outcome: SCRATCH_DIR_REMOVAL_OUTCOMES.SKIPPED_LIVE };
    }
    await killScratchDirHolders(preDeleteCheck.holders);
    const postKillCheck = await readScratchDirHolders(dirPath);
    if (postKillCheck.detectionFailed || postKillCheck.holders.length > 0) {
      return { dirPath, outcome: SCRATCH_DIR_REMOVAL_OUTCOMES.SKIPPED_LIVE };
    }
  }

  try {
    await dependencies.removeDirectory(dirPath);
  } catch (error) {
    return { dirPath, outcome: SCRATCH_DIR_REMOVAL_OUTCOMES.FAILED, errorCode: errorCodeOf(error) };
  }
  return { dirPath, outcome: SCRATCH_DIR_REMOVAL_OUTCOMES.REMOVED };
}
