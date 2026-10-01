import * as fileSystem from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export * from 'node:fs/promises';

export const FIRST_CONTENDER = 'first';
export const LATE_CONTENDER = 'late';
export type PinnedContender = typeof FIRST_CONTENDER | typeof LATE_CONTENDER;

export interface PinnedBudgetPaths {
  readonly lockPath: string;
  readonly tallyPath: string;
  readonly lateContenderSawTheStaleLock: string;
}

const POLL_MILLISECONDS = 2;
const LONGEST_WAIT_FOR_THE_RIVAL_MILLISECONDS = 3000;
const LONGEST_WAIT_FOR_A_RIVAL_TALLY_WRITE_MILLISECONDS = 500;
const STALE_CLAIM_SUFFIX = '.stale-claim';

let pinned: { readonly contender: PinnedContender; readonly paths: PinnedBudgetPaths } | undefined;

export function pinTheBudgetFileSystemAs(contender: PinnedContender, paths: PinnedBudgetPaths): void {
  pinned = { contender, paths };
}

async function waitUntil(isTrue: () => Promise<boolean>, longestWaitMilliseconds: number): Promise<void> {
  const deadline = Date.now() + longestWaitMilliseconds;
  while (Date.now() < deadline && !(await isTrue())) await sleep(POLL_MILLISECONDS);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fileSystem.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function aSpenderHoldsTheLock(paths: PinnedBudgetPaths): Promise<boolean> {
  try {
    const record = JSON.parse(await fileSystem.readFile(path.join(paths.lockPath, 'holder.json'), 'utf8')) as {
      readonly holder: string;
    };
    return record.holder.startsWith('jev budget') && !(await exists(`${paths.lockPath}${STALE_CLAIM_SUFFIX}`));
  } catch {
    return false;
  }
}

async function aRivalTallyWriteExists(paths: PinnedBudgetPaths, ownTemporaryPath: string): Promise<boolean> {
  const tallyFileName = path.basename(paths.tallyPath);
  return (await fileSystem.readdir(path.dirname(paths.tallyPath))).some(
    (fileName) =>
      fileName.startsWith(`${tallyFileName}.`) &&
      fileName.endsWith('.tmp') &&
      fileName !== path.basename(ownTemporaryPath),
  );
}

async function holdBeforeClaimingTheStaleLock(contender: PinnedContender, paths: PinnedBudgetPaths): Promise<void> {
  if (contender === LATE_CONTENDER) {
    await fileSystem.writeFile(paths.lateContenderSawTheStaleLock, '');
    await waitUntil(() => aSpenderHoldsTheLock(paths), LONGEST_WAIT_FOR_THE_RIVAL_MILLISECONDS);
  } else {
    await waitUntil(() => exists(paths.lateContenderSawTheStaleLock), LONGEST_WAIT_FOR_THE_RIVAL_MILLISECONDS);
  }
}

export const open: typeof fileSystem.open = async (filePath, flags, mode) => {
  if (pinned !== undefined && String(filePath).endsWith(STALE_CLAIM_SUFFIX)) {
    await holdBeforeClaimingTheStaleLock(pinned.contender, pinned.paths);
  }
  return fileSystem.open(filePath, flags, mode);
};

export const rename: typeof fileSystem.rename = async (from, to) => {
  if (pinned?.contender === FIRST_CONTENDER && String(to) === pinned.paths.tallyPath) {
    const { paths } = pinned;
    await waitUntil(() => aRivalTallyWriteExists(paths, String(from)), LONGEST_WAIT_FOR_A_RIVAL_TALLY_WRITE_MILLISECONDS);
  }
  return fileSystem.rename(from, to);
};
