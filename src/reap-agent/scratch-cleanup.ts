import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findScratchDirHolders } from '../tmp-scratch-lifecycle/scratch-dir-holders.ts';
import { killScratchDirHolders } from '../tmp-scratch-lifecycle/kill-scratch-dir-holders.ts';
import { removeScratchDir } from '../tmp-scratch-lifecycle/remove-scratch-dir.ts';
import {
  SCRATCH_DIR_REMOVAL_OUTCOMES,
  type ScratchDirRemovalResult,
} from '../tmp-scratch-lifecycle/tmp-scratch-lifecycle.types.ts';

export function scratchRootDir(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, 'tmp');
}

async function listAgentScratchDirs(
  agentName: string,
  tmpRoot: string,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const prefix = `${agentName}-`;
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(tmpRoot, entry.name));
}

/**
 * Kills any process currently holding `dirPath`, ahead of a `removeScratchDir`
 * call. This is safe only for a caller that has already, independently,
 * established the directory is exclusively attributable to an agent
 * confirmed dead — `reapAgentScratchDirs` is that caller, via the
 * `<agentName>-*` naming convention and the live-agent guard its own caller
 * (`executeTeardown`) runs before it. A detection failure (e.g. `/proc`
 * unreadable) fails safe by attempting no kill at all, leaving
 * `removeScratchDir`'s own fail-safe initial check to skip the directory.
 */
async function killConfirmedOrphanHolders(dirPath: string): Promise<void> {
  let holders;
  try {
    holders = await findScratchDirHolders(dirPath);
  } catch {
    return;
  }
  if (holders.length > 0) {
    await killScratchDirHolders(holders);
  }
}

/**
 * Removes every scratch directory attributable to `agentName` under
 * `tmpRoot` (matched by the `<agent-name>-*` naming convention). Unlike
 * `sweep-tmp-scratch`, this caller's ownership attribution is proven — the
 * live-agent guard upstream of `executeTeardown` has already confirmed
 * `agentName` is dead — so any holder found is an orphan of that dead agent
 * and is killed before `removeScratchDir`'s own liveness-gated removal runs,
 * unmodified, as the final delete decision.
 */
export async function reapAgentScratchDirs(
  agentName: string,
  tmpRoot: string = scratchRootDir(),
): Promise<ScratchDirRemovalResult[]> {
  const scratchDirs = await listAgentScratchDirs(agentName, tmpRoot);
  const results: ScratchDirRemovalResult[] = [];
  for (const dirPath of scratchDirs) {
    await killConfirmedOrphanHolders(dirPath);
    results.push(await removeScratchDir(dirPath));
  }
  return results;
}

export function removedScratchDirs(
  results: ScratchDirRemovalResult[],
): string[] {
  return results
    .filter((result) => result.outcome === SCRATCH_DIR_REMOVAL_OUTCOMES.REMOVED)
    .map((result) => result.dirPath);
}

export function stillHeldScratchDirs(
  results: ScratchDirRemovalResult[],
): string[] {
  return results
    .filter(
      (result) => result.outcome === SCRATCH_DIR_REMOVAL_OUTCOMES.SKIPPED_LIVE,
    )
    .map((result) => result.dirPath);
}
