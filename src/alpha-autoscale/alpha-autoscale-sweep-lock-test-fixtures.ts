import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireSweepLock, type SweepLockAcquisition } from "./alpha-autoscale-sweep-lock.ts";

let testLockDirectory: string | undefined;

function ownTestLockDirectory(): string {
  if (testLockDirectory === undefined) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "alpha-autoscale-sweep-lock-"));
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
    testLockDirectory = directory;
  }
  return testLockDirectory;
}

export function uniqueTestSweepLockPath(): string {
  return path.join(ownTestLockDirectory(), `${randomUUID()}.lock`);
}

export function acquireSweepLockOfItsOwn(): Promise<SweepLockAcquisition> {
  return acquireSweepLock({ lockPath: uniqueTestSweepLockPath() });
}
