import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tryExclusiveFileLock, type HeldFileLock } from "../shared-policy/exclusive-file-lock.ts";
import { readTextFileIfPresent } from "../where-i-stand/file-presence.ts";

const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND;
export const DEFAULT_LOCK_DURATION = "5m";
export const LONGEST_LOCK_MILLISECONDS = 15 * MILLISECONDS_PER_MINUTE;
const LOCK_DURATION_FORM = /^(\d+)(s|m)$/;
const RELEASE_SIGNALS = ["SIGTERM", "SIGINT"] as const;
export const UNKNOWN_HOLDER = "an unknown holder";

export const FolderLockOutcome = {
  HeldByAnother: "held-by-another",
  Taken: "taken",
} as const;

export type FolderLockAttempt =
  | { readonly outcome: typeof FolderLockOutcome.HeldByAnother; readonly holder: string }
  | { readonly outcome: typeof FolderLockOutcome.Taken; readonly holder: string; readonly lock: HeldFileLock };

export function lockMillisecondsOf(duration: string): number {
  const match = LOCK_DURATION_FORM.exec(duration);
  if (match === null) throw new Error(`--ttl takes a whole number of seconds or minutes, such as 90s or 5m, got "${duration}"`);
  const milliseconds = Number(match[1]) * (match[2] === "m" ? MILLISECONDS_PER_MINUTE : MILLISECONDS_PER_SECOND);
  if (milliseconds === 0) throw new Error("--ttl must be longer than zero");
  if (milliseconds > LONGEST_LOCK_MILLISECONDS) throw new Error(`--ttl may be at most 15m, got "${duration}"`);
  return milliseconds;
}

export function waitForStopOrTimeout(holdForMilliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, holdForMilliseconds);
    for (const signal of RELEASE_SIGNALS) {
      process.on(signal, () => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}

async function readHolder(lockFile: string): Promise<string> {
  try {
    const holder = (await readTextFileIfPresent(lockFile))?.trim() ?? "";
    return holder === "" ? UNKNOWN_HOLDER : holder;
  } catch {
    return UNKNOWN_HOLDER;
  }
}

export async function takeFolderLock(
  lockFile: string,
  lockName: string,
  holderName: string,
  until: Date,
): Promise<FolderLockAttempt> {
  await mkdir(path.dirname(lockFile), { recursive: true });
  const lock = await tryExclusiveFileLock(lockFile, lockName);
  if (lock === undefined) return { outcome: FolderLockOutcome.HeldByAnother, holder: await readHolder(lockFile) };
  const holder = `${holderName} until ${until.toISOString()}`;
  try {
    await writeFile(lockFile, `${holder}\n`, "utf8");
  } catch (error) {
    await lock.release();
    throw error;
  }
  return { outcome: FolderLockOutcome.Taken, holder, lock };
}
