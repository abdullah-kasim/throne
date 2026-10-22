import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { agentRegistrationExists } from "../agentdata/spawn-data-contracts.ts";
import { readScratchPaneMarkers } from "./scratch-pane-markers.ts";
import { runScratchPane } from "./scratch-pane.ts";

const OWNER = "shadow-baker-01";
const NOW = new Date("2026-10-16T12:00:00.000Z");
const LATER = "2026-10-16T14:00:00.000Z";
const EARLIER = "2026-10-16T11:00:00.000Z";

interface CommandRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function scratchThroneHome(t: TestContext): Promise<string> {
  const throneHome = await mkdtemp(path.join(tmpdir(), "scratch-pane-"));
  t.after(() => rm(throneHome, { recursive: true, force: true }));
  const ownerLedger = path.join(throneHome, "data", OWNER);
  await mkdir(ownerLedger, { recursive: true });
  await writeFile(path.join(ownerLedger, "identity.md"), `name: ${OWNER}\n`);
  return throneHome;
}

async function runCommand(throneHome: string, commandArguments: readonly string[]): Promise<CommandRun> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runScratchPane(commandArguments, {
    environment: { THRONE_DATA_HOME: throneHome },
    now: () => NOW,
    isKnownAgent: (name) => agentRegistrationExists(name, path.join(throneHome, "data")),
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  return { exitCode, stdout, stderr };
}

test("a live agent can register an unnamed pane it owns until a time", async (t) => {
  const throneHome = await scratchThroneHome(t);

  const run = await runCommand(throneHome, ["register", "w1:p7", "--owner", OWNER, "--until", LATER]);

  assert.deepEqual(run, {
    exitCode: 0,
    stdout: `Registered scratch pane w1:p7, owner ${OWNER}, until ${LATER}.\n`,
    stderr: "",
  });
  assert.deepEqual(await readScratchPaneMarkers({ THRONE_DATA_HOME: throneHome }), [
    { paneId: "w1:p7", owner: OWNER, until: LATER, reported: false },
  ]);
});

test("registering a scratch pane for an unknown owner or a past time is refused", async (t) => {
  const throneHome = await scratchThroneHome(t);
  const cases = [
    ["unknown owner", ["register", "w1:p7", "--owner", "shadow-nobody-01", "--until", LATER], /"shadow-nobody-01" is not a known agent/],
    ["past time", ["register", "w1:p7", "--owner", OWNER, "--until", EARLIER], /has already passed/],
    ["time that does not parse", ["register", "w1:p7", "--owner", OWNER, "--until", "teatime"], /"teatime" is not a time/],
  ] as const;
  for (const [failureMode, args, reason] of cases) {
    const run = await runCommand(throneHome, args);
    assert.equal(run.exitCode, 2, failureMode);
    assert.match(run.stderr, reason, failureMode);
    assert.match(run.stderr, /No bypass is available/, failureMode);
    assert.match(run.stderr, /Name the pane, a known agent as its owner, and a future time/, failureMode);
  }
  assert.deepEqual(await readScratchPaneMarkers({ THRONE_DATA_HOME: throneHome }), []);
});

test("an unknown flag or a missing pane, owner or time is refused with the usage", async (t) => {
  const throneHome = await scratchThroneHome(t);
  const cases = [
    ["unknown flag", ["register", "w1:p7", "--owner", OWNER, "--until", LATER, "--forever"], /Unknown option '--forever'/],
    ["missing pane", ["register", "--owner", OWNER, "--until", LATER], /missing <pane>/],
    ["missing owner", ["register", "w1:p7", "--until", LATER], /missing --owner/],
    ["missing time", ["register", "w1:p7", "--owner", OWNER], /missing --until/],
    ["missing subcommand", [], /the only subcommand is register/],
  ] as const;
  for (const [failureMode, args, reason] of cases) {
    const run = await runCommand(throneHome, args);
    assert.equal(run.exitCode, 2, failureMode);
    assert.match(run.stderr, /^Usage: throne scratch-pane register/, failureMode);
    assert.match(run.stderr, reason, failureMode);
    assert.match(run.stderr, /No bypass is available/, failureMode);
  }
  assert.deepEqual(await readScratchPaneMarkers({ THRONE_DATA_HOME: throneHome }), []);
});
