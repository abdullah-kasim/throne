import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const TEST_FILE_TIME_LIMIT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const REPORT_GRACE_MS = 5000;
const REPORT_CHECK_INTERVAL_MS = 100;
const OVERDUE_LINE_PREFIX = "suite-test-file-watchdog: test file past its time limit: ";
const KILLED_LINE_PREFIX = "suite-test-file-watchdog: killed test file: ";
const KILLED_LINE_PATTERN = /suite-test-file-watchdog: killed test file: (\S+)/;

const runFile = promisify(execFile);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const formatSeconds = (milliseconds) => `${(milliseconds / 1000).toFixed(1)}s`;

export function listKilledTestFiles(suiteOutput) {
  const names = [];
  for (const line of suiteOutput.split("\n")) {
    const match = KILLED_LINE_PATTERN.exec(line);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

async function listProcesses() {
  const { stdout } = await runFile("ps", ["-A", "-ww", "-o", "pid=,ppid=,etime=,args="], { maxBuffer: 64 * 1024 * 1024 });
  const processes = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match) processes.push({ pid: Number(match[1]), parentPid: Number(match[2]), elapsed: match[3], command: match[4] });
  }
  return processes;
}

function listProcessTree(processes, rootPid) {
  const tree = processes.filter((listed) => listed.pid === rootPid);
  for (let index = 0; index < tree.length; index += 1) {
    tree.push(...processes.filter((listed) => listed.parentPid === tree[index].pid));
  }
  return tree;
}

async function readDiagnosticReport(reportDirectory, pid, graceMs) {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const reportName = (await readdir(reportDirectory)).find((name) => name.includes(`.${pid}.`));
    if (reportName) {
      try {
        return JSON.parse(await readFile(path.join(reportDirectory, reportName), "utf8"));
      } catch {}
    }
    await wait(REPORT_CHECK_INTERVAL_MS);
  }
  return undefined;
}

function describeReport(report, graceMs) {
  if (!report) {
    return [`  no stack: the file did not answer a diagnostic report request within ${formatSeconds(graceMs)}, so its event loop is likely blocked`];
  }
  const stack = report.javascriptStack?.stack ?? [];
  const activeHandles = (report.libuv ?? []).filter((handle) => handle.is_active && handle.is_referenced);
  return [
    stack.length > 0 ? "  JavaScript stack:" : "  JavaScript stack: none, the event loop was idle and waiting on these handles",
    ...stack.map((frame) => `    ${frame.trim()}`),
    "  active handles keeping it alive:",
    ...activeHandles.map((handle) =>
      `    ${handle.type}${handle.pid ? ` pid ${handle.pid}` : ""}${handle.remoteEndpoint ? ` to ${JSON.stringify(handle.remoteEndpoint)}` : ""}`,
    ),
  ];
}

function killProcessTree(tree) {
  for (const listed of tree) {
    try {
      process.kill(listed.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

async function stopOverdueTestFile(testFile, { limitMs, reportDirectory, reportGraceMs, writeLine }) {
  writeLine(`${OVERDUE_LINE_PREFIX}${testFile.name} ran ${formatSeconds(Date.now() - testFile.firstSeenAt)} against a ${formatSeconds(limitMs)} limit`);
  try {
    process.kill(testFile.pid, "SIGUSR2");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  for (const line of describeReport(await readDiagnosticReport(reportDirectory, testFile.pid, reportGraceMs), reportGraceMs)) writeLine(line);
  const tree = listProcessTree(await listProcesses(), testFile.pid);
  if (tree.length === 0) {
    writeLine(`suite-test-file-watchdog: ${testFile.name} exited on its own before it could be killed`);
    return;
  }
  writeLine("  process tree (pid, elapsed, command):");
  for (const listed of tree) writeLine(`    ${listed.pid} ${listed.elapsed} ${listed.command}`);
  killProcessTree(tree);
  writeLine(`${KILLED_LINE_PREFIX}${testFile.name}`);
}

function watchTestFiles(testRunnerPid, options) {
  const testFiles = new Map();
  const stoppedPids = new Set();
  let currentCheck;

  const checkTestFiles = async () => {
    const now = Date.now();
    for (const listed of await listProcesses()) {
      if (listed.parentPid !== testRunnerPid || stoppedPids.has(listed.pid)) continue;
      const key = `${listed.pid} ${listed.command}`;
      if (!testFiles.has(key)) testFiles.set(key, { pid: listed.pid, name: listed.command.split(/\s+/).at(-1), firstSeenAt: now });
      const testFile = testFiles.get(key);
      if (now - testFile.firstSeenAt < options.limitMs) continue;
      stoppedPids.add(testFile.pid);
      await stopOverdueTestFile(testFile, options);
    }
  };

  const timer = setInterval(() => {
    if (currentCheck) return;
    currentCheck = checkTestFiles()
      .catch((error) => options.writeLine(`suite-test-file-watchdog: check failed: ${error.message}`))
      .finally(() => {
        currentCheck = undefined;
      });
  }, options.pollMs);

  return async () => {
    clearInterval(timer);
    await currentCheck;
  };
}

export async function runWatchedTestCommand([command, ...argumentsList], {
  limitMs = TEST_FILE_TIME_LIMIT_MS,
  pollMs = POLL_INTERVAL_MS,
  reportGraceMs = REPORT_GRACE_MS,
  writeLine = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const reportDirectory = await mkdtemp(path.join(os.tmpdir(), "suite-test-file-reports-"));
  const nodeOptions = [process.env.NODE_OPTIONS, "--report-on-signal", `--report-directory=${reportDirectory}`].filter(Boolean).join(" ");
  const testRunner = spawn(command, argumentsList, { env: { ...process.env, NODE_OPTIONS: nodeOptions }, stdio: "inherit" });
  const stopWatching = watchTestFiles(testRunner.pid, { limitMs, pollMs, reportGraceMs, reportDirectory, writeLine });
  const status = await new Promise((resolve) => {
    testRunner.once("error", (error) => {
      console.error(`run-suite-guarded-tests: failed to run ${command}: ${error.message}`);
      resolve(1);
    });
    testRunner.once("close", (exitStatus) => resolve(exitStatus ?? 1));
  });
  await stopWatching();
  await rm(reportDirectory, { recursive: true, force: true });
  return status;
}
