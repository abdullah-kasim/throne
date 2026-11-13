import path from "node:path";
import { releaseLock, tryTakeLock, waitForLock } from "./lock-rows/lock-rows.ts";
import { resolveThroneHome } from "./throne-home.ts";

const WAIT_WITHOUT_LIMIT_MS = Number.POSITIVE_INFINITY;

function lockRowName(lockFile: string): string {
  return path.resolve(lockFile);
}

export async function withExclusiveFileLock<Result>(
  lockFile: string,
  lockName: string,
  work: () => Promise<Result>,
): Promise<Result> {
  const held = await waitForLock(resolveThroneHome(), lockRowName(lockFile), WAIT_WITHOUT_LIMIT_MS);
  if (held === null) throw new Error(`the ${lockName} lock could not be taken`);
  try {
    return await work();
  } finally {
    releaseLock(held);
  }
}

export interface HeldFileLock {
  readonly release: () => Promise<void>;
}

export async function tryExclusiveFileLock(lockFile: string, _lockName: string): Promise<HeldFileLock | undefined> {
  const held = tryTakeLock(resolveThroneHome(), lockRowName(lockFile));
  return held === null ? undefined : { release: async () => releaseLock(held) };
}
