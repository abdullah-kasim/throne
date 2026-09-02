import { rm, stat } from 'node:fs/promises';
import { findScratchDirHolders, indexClearsDirectory } from './scratch-dir-holders.ts';
import { killScratchDirHolders } from './kill-scratch-dir-holders.ts';
import {
  SCRATCH_DIR_REMOVAL_OUTCOMES,
  type ScratchDirHolder,
  type ScratchDirRemovalResult,
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

async function isDirTooYoung(
  dirPath: string,
  minAgeMs: number,
): Promise<boolean> {
  try {
    const stats = await stat(dirPath);
    return Date.now() - stats.mtimeMs < minAgeMs;
  } catch {
    // Nothing exists to be "too young"; let the liveness/delete steps
    // below resolve this the same way they would for any missing dir.
    return false;
  }
}

/**
 * Read-only variant of the delete-eligibility decision: age gate AND
 * liveness gate, the same two checks `removeScratchDir` acts on, without
 * killing a holder or deleting anything. `REMOVED` here means "eligible
 * for removal", not "removed" — callers that only want a report (a
 * dry-run) read it that way, while `removeScratchDir` treats it as
 * permission to proceed to the kill+delete steps below.
 *
 * When `index` is supplied, the liveness gate is answered from that
 * once-per-sweep snapshot instead of a fresh `/proc` walk — a fast-path
 * pre-filter only, per the race-safety invariant: this is never the last
 * word on an actual deletion, which always re-checks freshly in
 * `removeScratchDir` immediately before it deletes anything.
 */
export async function checkScratchDirRemovalEligibility(
  dirPath: string,
  minAgeMs?: number,
  index?: ScratchHolderIndex,
): Promise<ScratchDirRemovalResult> {
  if (minAgeMs !== undefined && (await isDirTooYoung(dirPath, minAgeMs))) {
    return { dirPath, outcome: SCRATCH_DIR_REMOVAL_OUTCOMES.SKIPPED_TOO_YOUNG };
  }

  if (index !== undefined) {
    return indexClearsDirectory(index, dirPath)
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
): Promise<ScratchDirRemovalResult> {
  const initialEligibility = await checkScratchDirRemovalEligibility(dirPath, minAgeMs, index);
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

  await rm(dirPath, { recursive: true, force: true });
  return { dirPath, outcome: SCRATCH_DIR_REMOVAL_OUTCOMES.REMOVED };
}
