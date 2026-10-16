import { spawn } from "node:child_process";
import { open, type FileHandle } from "node:fs/promises";

export const FLOCK_EXECUTABLE = "flock";
const LOCK_FILE_MODE = 0o600;
const LOCK_FILE_DESCRIPTOR_IN_FLOCK = 3;
const FLOCK_ERROR_OUTPUT_LIMIT = 64 * 1024;
const ALREADY_HELD_EXIT_CODE = 75;
const WAIT_FOR_THE_LOCK = ["--exclusive"];
const FAIL_WHEN_ALREADY_HELD = ["--exclusive", "--nonblock", "--conflict-exit-code", String(ALREADY_HELD_EXIT_CODE)];

const DescriptorLockOutcome = {
  Taken: "taken",
  AlreadyHeld: "already-held",
} as const;

type DescriptorLockOutcomeName = (typeof DescriptorLockOutcome)[keyof typeof DescriptorLockOutcome];

function executableIsMissing(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function flockNotInstalled(flockExecutable: string, lockName: string, error: Error): Error {
  return new Error(
    `${flockExecutable} is not installed, so the ${lockName} lock cannot be taken (${error.message}). ` +
      `Stock macOS ships no flock: run "brew install flock".`,
  );
}

function lockDescriptor(
  descriptor: number,
  lockName: string,
  flockExecutable: string,
  lockingFlags: readonly string[],
): Promise<DescriptorLockOutcomeName> {
  return new Promise((resolve, reject) => {
    const child = spawn(flockExecutable, [...lockingFlags, String(LOCK_FILE_DESCRIPTOR_IN_FLOCK)], {
      stdio: ["ignore", "ignore", "pipe", descriptor],
    });
    let errorOutput = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (errorOutput.length < FLOCK_ERROR_OUTPUT_LIMIT) errorOutput += chunk;
    });
    child.once("error", (error) => {
      reject(executableIsMissing(error) ? flockNotInstalled(flockExecutable, lockName, error) : error);
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(DescriptorLockOutcome.Taken);
        return;
      }
      if (code === ALREADY_HELD_EXIT_CODE && lockingFlags === FAIL_WHEN_ALREADY_HELD) {
        resolve(DescriptorLockOutcome.AlreadyHeld);
        return;
      }
      const detail = errorOutput.trim();
      reject(
        new Error(
          `${flockExecutable} could not acquire the ${lockName} lock` +
            `${signal === null ? ` (exit ${code ?? "unknown"})` : ` (${signal})`}` +
            `${detail === "" ? "" : `: ${detail}`}`,
        ),
      );
    });
  });
}

async function closeWithoutChangingOutcome(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    return;
  }
}

export async function withExclusiveFileLock<Result>(
  lockFile: string,
  lockName: string,
  work: () => Promise<Result>,
  flockExecutable: string = FLOCK_EXECUTABLE,
): Promise<Result> {
  const lockHandle = await open(lockFile, "a+", LOCK_FILE_MODE);
  try {
    await lockHandle.chmod(LOCK_FILE_MODE);
    await lockDescriptor(lockHandle.fd, lockName, flockExecutable, WAIT_FOR_THE_LOCK);
    return await work();
  } finally {
    await closeWithoutChangingOutcome(lockHandle);
  }
}

export interface HeldFileLock {
  readonly release: () => Promise<void>;
}

export async function tryExclusiveFileLock(
  lockFile: string,
  lockName: string,
  flockExecutable: string = FLOCK_EXECUTABLE,
): Promise<HeldFileLock | undefined> {
  const lockHandle = await open(lockFile, "a+", LOCK_FILE_MODE);
  try {
    await lockHandle.chmod(LOCK_FILE_MODE);
    const outcome = await lockDescriptor(lockHandle.fd, lockName, flockExecutable, FAIL_WHEN_ALREADY_HELD);
    if (outcome === DescriptorLockOutcome.Taken) return { release: () => closeWithoutChangingOutcome(lockHandle) };
  } catch (error) {
    await closeWithoutChangingOutcome(lockHandle);
    throw error;
  }
  await closeWithoutChangingOutcome(lockHandle);
  return undefined;
}
