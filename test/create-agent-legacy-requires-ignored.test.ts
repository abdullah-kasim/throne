import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";

const runFile = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const LEGACY_COURT = path.join(REPO_ROOT, "scripts", "capability-removal-evidence", "create-agent-legacy-court.ts");
const IGNORED_NOTICE = "create-agent-legacy: --requires ignored: capability requirements were removed on 2026-11-15.\n";
const scratchFolders: string[] = [];

after(async () => {
  await Promise.all(scratchFolders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function legacyShadowLaunch(extra: string[]): Promise<{ stdout: string; launch_arguments: string[][]; spawn: Record<string, unknown> | null }> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "create-agent-legacy-requires-"));
  scratchFolders.push(scratch);
  const dataHome = path.join(scratch, "throne-home");
  const agentCwd = path.join(scratch, "agent-cwd");
  await Promise.all([path.join(dataHome, "config"), path.join(scratch, "live-root"), agentCwd].map((folder) => mkdir(folder, { recursive: true })));
  await copyFile(path.join(REPO_ROOT, "config.user.example.ts"), path.join(dataHome, "config", "config.user.ts"));
  const { stdout } = await runFile(
    process.execPath,
    [LEGACY_COURT, "--model", "opus", "--role", "Shadow", "--name", "shadow-requires-opus", "--supervisor", "alpha-requires-01", "--non-campaign", ...extra, "--cwd", agentCwd],
    { cwd: REPO_ROOT, env: { ...process.env, THRONE_DATA_HOME: dataHome, THRONE_LIVE_ROOT: path.join(scratch, "live-root") } },
  );
  const outcome = JSON.parse(stdout.replaceAll(scratch, "<scratch>"));
  const { spawned_at: _spawned, tasked_at: _tasked, ...spawn } = outcome.spawn ?? {};
  return { stdout: outcome.stdout, launch_arguments: outcome.launch_arguments, spawn: outcome.spawn === null ? null : spawn };
}

test("create-agent-legacy with --requires, even one that used to be a parse error, launches as it would without it and prints one line saying it was ignored", async () => {
  const [without, withFloor, withBanana] = await Promise.all([
    legacyShadowLaunch([]),
    legacyShadowLaunch(["--requires", "non-coding>=4"]),
    legacyShadowLaunch(["--requires", "banana"]),
  ]);
  assert.equal(without.launch_arguments.length, 1);
  for (const launch of [withFloor, withBanana]) {
    assert.equal(launch.stdout, `${without.stdout}${IGNORED_NOTICE}`);
    assert.deepEqual(launch.launch_arguments, without.launch_arguments);
    assert.deepEqual(launch.spawn, without.spawn);
    assert.equal(launch.spawn?.capability, undefined);
  }
});
