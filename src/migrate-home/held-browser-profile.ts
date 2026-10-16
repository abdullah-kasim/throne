import { readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CHROMIUM_PROFILE_LOCK_NAME = "SingletonLock";

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readProfileLockOwner(profileFolder: string): Promise<string | undefined> {
  try {
    return await readlink(path.join(profileFolder, CHROMIUM_PROFILE_LOCK_NAME));
  } catch {
    return undefined;
  }
}

export async function isProfileHeldByARunningBrowser(profileFolder: string): Promise<boolean> {
  const owner = await readProfileLockOwner(profileFolder);
  if (owner === undefined) return false;
  const separator = owner.lastIndexOf("-");
  const host = owner.slice(0, separator);
  const processId = Number(owner.slice(separator + 1));
  return host === os.hostname() && Number.isInteger(processId) && isProcessRunning(processId);
}
