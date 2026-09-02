import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RUNTIME_DATA_DIR } from '../shared-policy/runtime-data-home.ts';
import { offenderKey } from './report-ledger.ts';
import type { ProcessRecord } from './detect.ts';

/**
 * Candidates an investigator has already judged and CLEARED — a legitimate
 * long-running job, not a wedged one. Ruling 5: never request a second
 * investigation for a process an investigator has already cleared. Without
 * this the watch re-requests an Opus spawn every escalation window for a
 * process someone already paid an Opus to look at and approve.
 *
 * The file is written by the Regent (or the investigator on its behalf), not
 * by this worker: the watch finds and reports, it never records judgements
 * it did not make. Entries are keyed `pid:starttime`, the same collision-free
 * process identity the report ledger uses, so a recycled pid is a new
 * process and gets a fresh look.
 */
export function clearedCandidatesPath(dataDir: string = RUNTIME_DATA_DIR): string {
  return path.join(dataDir, 'regent', 'procwatch-cleared-candidates.json');
}

/**
 * Returns an EMPTY set when the file is absent — nothing has been cleared
 * yet, which is the honest reading of "no file". A file that exists but
 * cannot be parsed is different: it is an UNKNOWN clearance state, and this
 * returns `undefined` so the caller can refuse the tick rather than treat a
 * corrupt file as "nothing was ever cleared" and re-request investigations
 * the court already paid for.
 */
export async function readClearedCandidates(
  clearedPath: string,
): Promise<ReadonlySet<string> | undefined> {
  let bytes: string;
  try {
    bytes = await readFile(clearedPath, 'utf8');
  } catch {
    return new Set();
  }
  try {
    const parsed = JSON.parse(bytes) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    if (!parsed.every((entry) => typeof entry === 'string')) return undefined;
    return new Set(parsed as string[]);
  } catch {
    return undefined;
  }
}

export function isCleared(
  offender: Pick<ProcessRecord, 'pid' | 'startTicks'>,
  cleared: ReadonlySet<string>,
): boolean {
  return cleared.has(offenderKey(offender));
}
