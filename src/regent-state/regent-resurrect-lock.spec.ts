import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  RESURRECT_LOCK_BASENAME,
  RESURRECT_LOCK_STALE_MS,
  acquireResurrectLock,
  isResurrectLockHeld,
} from "./regent-resurrect-lock.ts";

async function lockFolder(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "resurrect-lock-"));
}

async function processIdOfAnExitedProcess(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0);
  assert.notEqual(child.pid, undefined);
  return child.pid!;
}

async function writeLockHeldBy(folder: string, holderProcessId: number): Promise<string> {
  const content = `${holderProcessId}:${Date.now()}:holder\n`;
  await writeFile(path.join(folder, RESURRECT_LOCK_BASENAME), content);
  return content;
}

async function lockContent(folder: string): Promise<string> {
  return readFile(path.join(folder, RESURRECT_LOCK_BASENAME), "utf8");
}

test("a fresh lock whose holder process has exited is not held and is taken over at once", async () => {
  const folder = await lockFolder();
  await writeLockHeldBy(folder, await processIdOfAnExitedProcess());

  assert.equal(await isResurrectLockHeld(folder), false);
  const token = await acquireResurrectLock(folder);

  assert.notEqual(token, null);
  assert.equal(await lockContent(folder), `${token}\n`);
});

test("a fresh lock whose holder process is alive stays held and refuses a second claim", async () => {
  const folder = await lockFolder();
  const liveHolderContent = await writeLockHeldBy(folder, process.pid);

  assert.equal(await isResurrectLockHeld(folder), true);
  assert.equal(await acquireResurrectLock(folder), null);
  assert.equal(await lockContent(folder), liveHolderContent);
});

test("a lock whose live holder stopped refreshing it past the stale window is taken over", async () => {
  const folder = await lockFolder();
  await writeLockHeldBy(folder, process.pid);
  const pastTheStaleWindow = new Date(Date.now() - RESURRECT_LOCK_STALE_MS - 1_000);
  await utimes(path.join(folder, RESURRECT_LOCK_BASENAME), pastTheStaleWindow, pastTheStaleWindow);

  assert.equal(await isResurrectLockHeld(folder), false);
  assert.notEqual(await acquireResurrectLock(folder), null);
});

test("no lock file is not held and is claimed", async () => {
  const folder = await lockFolder();

  assert.equal(await isResurrectLockHeld(folder), false);
  assert.notEqual(await acquireResurrectLock(folder), null);
});
