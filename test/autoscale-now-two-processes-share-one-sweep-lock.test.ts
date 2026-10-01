import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const COMPILED_CLI = path.join(REPOSITORY_ROOT, "dist", "src", "tools.js");
const ROUTE_BACKEND = path.join(REPOSITORY_ROOT, "test", "fixtures", "alpha-autoscale-route-backend.mjs");
const HELD_SKIP_LINE = /skip: another alpha-autoscale sweep holds .* \(pid \d+ on .*, renewed \d+\.\ds ago\); not waiting, no page sent/;
const SWEEP_RAN_LINE = /floor breach: live=0 floor=\d+/;
const PROCESS_DEADLINE_MS = 90_000;

const FAKE_HERDR_WITH_ONLY_A_REGENT_THAT_WAITS_FOR_RELEASE = `#!/bin/sh
touch "$FAKE_HERDR_ARRIVALS/$$"
while [ ! -e "$FAKE_HERDR_RELEASE" ]; do sleep 0.05; done
printf '%s\\n' '{"result":{"agents":[{"agent":"claude","name":"Regent","terminal_id":"fake-terminal","pane_id":"fake-pane","tab_id":"fake-tab","agent_status":"idle"}]}}'
`;

interface IsolatedCourt {
  readonly base: string;
  readonly dataHome: string;
  readonly arrivals: string;
  readonly releaseFile: string;
  readonly environment: NodeJS.ProcessEnv;
}

interface FinishedProcess {
  readonly label: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunningProcess {
  readonly child: ChildProcess;
  readonly finished: Promise<FinishedProcess>;
}

async function isolatedCourt(): Promise<IsolatedCourt> {
  const base = await mkdtemp(path.join(os.tmpdir(), "asl-"));
  const dataHome = path.join(base, "d");
  const liveRoot = path.join(base, "root");
  const arrivals = path.join(base, "arrivals");
  const fakeHerdr = path.join(base, "fake-herdr");
  const releaseFile = path.join(base, "release");
  await mkdir(liveRoot);
  await mkdir(arrivals);
  await writeFile(fakeHerdr, FAKE_HERDR_WITH_ONLY_A_REGENT_THAT_WAITS_FOR_RELEASE);
  await chmod(fakeHerdr, 0o755);
  return {
    base,
    dataHome,
    arrivals,
    releaseFile,
    environment: {
      ...process.env,
      THRONE_DATA_HOME: dataHome,
      THRONE_LIVE_ROOT: liveRoot,
      THRONE_HERDR_CLIENT_PATH: fakeHerdr,
      FAKE_HERDR_ARRIVALS: arrivals,
      FAKE_HERDR_RELEASE: releaseFile,
    },
  };
}

function start(label: string, argv: readonly string[], court: IsolatedCourt): RunningProcess {
  const child = spawn(process.execPath, [...argv], {
    cwd: REPOSITORY_ROOT,
    env: court.environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const finished = new Promise<FinishedProcess>((resolve) => {
    child.once("close", (exitCode) => resolve({ label, exitCode, stdout, stderr }));
  });
  return { child, finished };
}

function describeFinished(finished: FinishedProcess): string {
  return `${finished.label} exited ${finished.exitCode}\nstdout:\n${finished.stdout}\nstderr:\n${finished.stderr}`;
}

async function withinDeadline<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within ${PROCESS_DEADLINE_MS}ms`)), PROCESS_DEADLINE_MS);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function winningSweepParkedInItsRosterRead(court: IsolatedCourt): Promise<void> {
  while ((await readdir(court.arrivals)).length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startRouteBackend(court: IsolatedCourt): Promise<RunningProcess> {
  const backend = start("backend", [ROUTE_BACKEND, REPOSITORY_ROOT], court);
  await withinDeadline(
    new Promise<void>((resolve, reject) => {
      backend.child.stdout!.on("data", (chunk: string) => {
        if (chunk.includes("listening")) resolve();
      });
      void backend.finished.then((finished) => reject(new Error(`the route backend exited early: ${finished.stderr}`)));
    }),
    "the route backend listening",
  );
  return backend;
}

async function proveTwoSimultaneousSweepsRunExactlyOnce(court: IsolatedCourt, extraArguments: readonly string[]): Promise<void> {
  const contenders = [
    start("first", [COMPILED_CLI, "autoscale-now", ...extraArguments], court),
    start("second", [COMPILED_CLI, "autoscale-now", ...extraArguments], court),
  ];
  try {
    const skipper = await withinDeadline(
      Promise.race(contenders.map((contender) => contender.finished)),
      "the losing autoscale-now exiting",
    );
    assert.equal(skipper.exitCode, 0, describeFinished(skipper));
    assert.match(skipper.stdout, HELD_SKIP_LINE);
    assert.doesNotMatch(skipper.stdout, SWEEP_RAN_LINE);
    await withinDeadline(winningSweepParkedInItsRosterRead(court), "the winning sweep reaching its roster read");

    await writeFile(court.releaseFile, "");
    const outcomes = await withinDeadline(
      Promise.all(contenders.map((contender) => contender.finished)),
      "the winning autoscale-now finishing",
    );
    const sweeper = outcomes.find((outcome) => outcome.label !== skipper.label)!;
    assert.equal(sweeper.exitCode, 0, describeFinished(sweeper));
    assert.match(sweeper.stdout, SWEEP_RAN_LINE);
    assert.doesNotMatch(sweeper.stdout, HELD_SKIP_LINE);
    assert.equal(
      outcomes.filter((outcome) => SWEEP_RAN_LINE.test(outcome.stdout)).length,
      1,
      "exactly one of the two processes ran the sweep",
    );
    assert.deepEqual(await readdir(path.join(court.dataHome, "locks")), [], "the lock and its private files are gone");
  } finally {
    for (const contender of contenders) contender.child.kill("SIGKILL");
  }
}

test("two autoscale-now --local processes started at once run exactly one sweep; the other prints the skip line and exits 0", async () => {
  const court = await isolatedCourt();
  try {
    await proveTwoSimultaneousSweepsRunExactlyOnce(court, ["--local"]);
  } finally {
    await rm(court.base, { recursive: true, force: true });
  }
});

test("two autoscale-now processes over REST started at once run exactly one sweep inside the backend; the other prints the skip line and exits 0", async () => {
  const court = await isolatedCourt();
  const backend = await startRouteBackend(court);
  try {
    await proveTwoSimultaneousSweepsRunExactlyOnce(court, []);
  } finally {
    backend.child.kill("SIGKILL");
    await backend.finished;
    await rm(court.base, { recursive: true, force: true });
  }
});

test("autoscale-now with no backend listening exits non-zero with one line naming --local and runs no sweep", async () => {
  const court = await isolatedCourt();
  try {
    const finished = await withinDeadline(
      start("no-backend", [COMPILED_CLI, "autoscale-now"], court).finished,
      "autoscale-now against a dead backend exiting",
    );
    assert.notEqual(finished.exitCode, 0);
    const failureLines = finished.stderr.split("\n").filter((line) => line.includes("unreachable"));
    assert.equal(failureLines.length, 1, finished.stderr);
    assert.match(failureLines[0]!, /--local/);
    assert.equal(finished.stdout, "");
    assert.deepEqual(await readdir(court.arrivals), [], "no sweep ran anywhere");
  } finally {
    await rm(court.base, { recursive: true, force: true });
  }
});
