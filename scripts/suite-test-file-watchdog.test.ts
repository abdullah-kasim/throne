import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TEST_FILE_TIME_LIMIT_MS } from "./suite-test-file-watchdog.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const guardedTestsRunnerUrl = pathToFileURL(path.join(scriptsDirectory, "run-suite-guarded-tests.mjs")).href;
const fixturesDirectory = path.join(scriptsDirectory, "..", "test", "fixtures", "suite-test-file-watchdog");
const fixture = (name: string) => path.join(fixturesDirectory, name);
const shortWatch = { limitMs: 1000, pollMs: 100, reportGraceMs: 1000 };

function runGuardedTests(testFiles: string[], watchOptions: object, environment: Record<string, string> = {}) {
  const commandArguments = [
    "--guard",
    process.execPath,
    "-e",
    "console.log('the post-guard ran')",
    "--test",
    process.execPath,
    "--test",
    ...testFiles,
  ];
  const script = `import { runGuardedTests } from ${JSON.stringify(guardedTestsRunnerUrl)};
process.exitCode = await runGuardedTests(${JSON.stringify(commandArguments)}, ${JSON.stringify(watchOptions)});`;
  const { NODE_TEST_CONTEXT: _testContext, ...parentEnvironment } = process.env;
  const startedAt = Date.now();
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...parentEnvironment, ...environment },
    timeout: 30_000,
  });
  return { ...run, output: run.stdout + run.stderr, durationMs: Date.now() - startedAt };
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const processState = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return !processState.startsWith("Z");
}

let hungRun: ReturnType<typeof runGuardedTests>;
let leftRunningChildPid: number;

before(() => {
  const pidFile = path.join(mkdtempSync(path.join(os.tmpdir(), "suite-test-file-watchdog-")), "child.pid");
  hungRun = runGuardedTests(
    [fixture("finishes-quickly.mjs"), fixture("leaves-a-child-running.mjs"), fixture("blocks-its-event-loop.mjs")],
    shortWatch,
    { LEFT_RUNNING_CHILD_PID_FILE: pidFile },
  );
  leftRunningChildPid = Number(readFileSync(pidFile, "utf8"));
});

test("a test file that runs past the bound is killed and the run fails naming it", () => {
  assert.equal(TEST_FILE_TIME_LIMIT_MS, 5 * 60 * 1000);
  assert.notEqual(hungRun.status, 0);
  assert.match(hungRun.output, /test file past its time limit: \S*leaves-a-child-running\.mjs ran \d+\.\ds against a 1\.0s limit/);
  assert.match(hungRun.output, /test file past its time limit: \S*blocks-its-event-loop\.mjs ran /);
  assert.match(hungRun.output, /killed test file: \S*leaves-a-child-running\.mjs\n/);
  assert.match(hungRun.output, /killed test file: \S*blocks-its-event-loop\.mjs\n/);
  assert.doesNotMatch(hungRun.output, /time limit: \S*finishes-quickly/);
  assert.match(hungRun.output, /✔ finishes quickly/);
});

test("the post-guards still run after a hung test file is killed", () => {
  assert.ok(hungRun.stdout.lastIndexOf("past its time limit") < hungRun.stdout.indexOf("the post-guard ran"));
});

test("a hung test file's report says where it was stuck", () => {
  assert.match(hungRun.output, /JavaScript stack: none, the event loop was idle and waiting on these handles/);
  assert.match(hungRun.output, new RegExp(`process pid ${leftRunningChildPid}\\n`));
  assert.match(hungRun.output, /no stack: the file did not answer a diagnostic report request within 1\.0s, so its event loop is likely blocked/);
  assert.match(hungRun.output, new RegExp(`process tree \\(pid, elapsed, command\\):\\n(.*\\n)*? +${leftRunningChildPid} \\S+ \\S*node -e setInterval`));
});

test("a child process left running by a hung test file is killed with it", () => {
  assert.equal(isRunning(leftRunningChildPid), false);
});

test("a run where every test file finishes in time is unchanged by the watchdog", () => {
  const watchedRun = runGuardedTests([fixture("finishes-quickly.mjs")], { ...shortWatch, pollMs: 60_000 });

  assert.equal(watchedRun.status, 0);
  assert.ok(watchedRun.durationMs < 60_000);
  assert.doesNotMatch(watchedRun.output, /suite-test-file-watchdog/);
  assert.match(watchedRun.output, /the post-guard ran/);
});
