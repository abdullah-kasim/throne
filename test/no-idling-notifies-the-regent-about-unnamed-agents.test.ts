import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runNoIdling } from "../src/no-idling/no-idling-run.ts";
import { deps, fakeAgent, liveEntry, type SubmitCall } from "../src/no-idling/no-idling-command-test-fixtures.ts";
import { registerScratchPane } from "../src/scratch-pane/scratch-pane.ts";
import { ConfirmedObservationTracker } from "../src/no-idling/confirmed-observation.ts";
import type { UnnamedAgentReport } from "../src/no-idling/unnamed-agent-report.ts";
import type { HerdrAgent } from "../src/herdr/herdr-inventory.service.ts";

const MINUTE_MS = 60 * 1000;
const FIRST_SWEEP_MS = Date.UTC(2026, 9, 8, 12);
const UNNAMED_AGENTS_KEY_PREFIX = "no-idling-unnamed-agents:";

const UNNAMED_STAGER_PANE: UnnamedAgentReport = {
  paneId: "w1:pT",
  tabId: "w1:t7",
  tabLabel: "stager-fable",
  cwd: "/throne/stager-fable",
  harness: "claude",
  agentSessionId: "session-1",
  likelyOwner: "stager-fable",
};

const SCRATCH_PANE_OWNER = "shadow-scratch-01";

const SCRATCH_CLAUDE_PANE: UnnamedAgentReport = {
  paneId: "w1:pS",
  tabId: "w1:t9",
  cwd: "/home/baker/tmp/scratch",
  harness: "claude",
  agentSessionId: "session-scratch",
};

interface Court {
  readonly clock: { nowMs: number };
  unnamedAgents: UnnamedAgentReport[];
  liveAgentNames: string[];
  regentStatus: HerdrAgent["agentStatus"];
  sweep(options?: { notify: boolean }): Promise<readonly SubmitCall[]>;
}

function court(): Court {
  const tracker = new ConfirmedObservationTracker();
  const state: Court = {
    clock: { nowMs: FIRST_SWEEP_MS },
    unnamedAgents: [UNNAMED_STAGER_PANE],
    liveAgentNames: [],
    regentStatus: "idle",
    async sweep(options = { notify: true }) {
      const { dependencies, submitCalls } = deps({
        getRoster: async () => state.liveAgentNames.map((name) => liveEntry(name, "shadow", "idle")),
        detectUnnamedAgents: async () => state.unnamedAgents,
        unnamedAgentTracker: tracker,
        resolveAgent: async (name) => ({ ...fakeAgent(name, "idle"), agentStatus: state.regentStatus }),
        now: () => state.clock.nowMs,
        stdout: () => {},
        stderr: () => {},
      });
      await runNoIdling(dependencies, options);
      state.clock.nowMs += MINUTE_MS;
      return submitCalls.filter(
        (call) => call.target.name === "Regent" && call.options?.key?.startsWith(UNNAMED_AGENTS_KEY_PREFIX),
      );
    },
  };
  return state;
}

test("an unnamed live agent does not page the Regent on the first sweep that sees it", async () => {
  const notices = await court().sweep();
  assert.deepEqual(notices, []);
});

test("an unnamed live agent pages the Regent on the second consecutive sweep that sees it", async () => {
  const sweeps = court();
  await sweeps.sweep();
  const notices = await sweeps.sweep();
  assert.equal(notices.length, 1);
  assert.match(notices[0].prompt, /herdr agent rename w1:pT stager-fable/);
});

test("an unnamed live agent keeps paging the Regent on every later sweep until it is renamed", async () => {
  const sweeps = court();
  await sweeps.sweep();
  const secondSweep = await sweeps.sweep();
  const thirdSweep = await sweeps.sweep();
  assert.equal(secondSweep.length, 1);
  assert.equal(thirdSweep.length, 1);
  assert.notEqual(thirdSweep[0].options?.key, secondSweep[0].options?.key);
  sweeps.unnamedAgents = [];
  assert.deepEqual(await sweeps.sweep(), []);
});

test("the sweep says nothing about unnamed agents when every live agent is named", async () => {
  const sweeps = court();
  sweeps.unnamedAgents = [];
  await sweeps.sweep();
  assert.deepEqual(await sweeps.sweep(), []);
});

test("a report-only sweep never sends the unnamed-agent notice", async () => {
  const sweeps = court();
  await sweeps.sweep({ notify: false });
  assert.deepEqual(await sweeps.sweep({ notify: false }), []);
});

test("the unnamed-agent notice waits while the Regent cannot accept notices", async () => {
  const sweeps = court();
  sweeps.regentStatus = "blocked";
  await sweeps.sweep();
  assert.deepEqual(await sweeps.sweep(), []);
  sweeps.regentStatus = "idle";
  assert.equal((await sweeps.sweep()).length, 1);
});

async function scratchThroneHome(t: TestContext): Promise<void> {
  const previousThroneHome = process.env.THRONE_DATA_HOME;
  const throneHome = await mkdtemp(path.join(tmpdir(), "scratch-pane-sweep-"));
  process.env.THRONE_DATA_HOME = throneHome;
  t.after(async () => {
    if (previousThroneHome === undefined) delete process.env.THRONE_DATA_HOME;
    else process.env.THRONE_DATA_HOME = previousThroneHome;
    await rm(throneHome, { recursive: true, force: true });
  });
}

async function registerScratchPaneFor(sweeps: Court, paneId: string, untilMs: number): Promise<void> {
  await registerScratchPane(
    { paneId, owner: SCRATCH_PANE_OWNER, until: new Date(untilMs) },
    {
      environment: process.env,
      now: () => new Date(sweeps.clock.nowMs),
      isKnownAgent: async () => true,
      writeStdout: () => {},
      writeStderr: () => {},
    },
  );
}

function scratchPaneCourt(): Court {
  const sweeps = court();
  sweeps.unnamedAgents = [SCRATCH_CLAUDE_PANE];
  sweeps.liveAgentNames = [SCRATCH_PANE_OWNER];
  return sweeps;
}

test("the unnamed-agent sweep is silent about a registered pane while its owner is alive and the time has not passed", async (t) => {
  await scratchThroneHome(t);
  const sweeps = scratchPaneCourt();
  await registerScratchPaneFor(sweeps, SCRATCH_CLAUDE_PANE.paneId, FIRST_SWEEP_MS + 60 * MINUTE_MS);
  for (let sweep = 0; sweep < 3; sweep += 1) {
    assert.deepEqual(await sweeps.sweep(), []);
  }
});

test("a registered pane past its time is reported once as an expired scratch pane naming its owner", async (t) => {
  await scratchThroneHome(t);
  const sweeps = scratchPaneCourt();
  await registerScratchPaneFor(sweeps, SCRATCH_CLAUDE_PANE.paneId, FIRST_SWEEP_MS + MINUTE_MS + 1);
  assert.deepEqual(await sweeps.sweep(), []);
  assert.deepEqual(await sweeps.sweep(), []);
  const expiredSweep = await sweeps.sweep();
  assert.equal(expiredSweep.length, 1);
  assert.match(expiredSweep[0].prompt, new RegExp(`pane w1:pS .*expired scratch pane, owner ${SCRATCH_PANE_OWNER}`));
  assert.deepEqual(await sweeps.sweep(), []);
  assert.deepEqual(await sweeps.sweep(), []);
});

test("a registered pane whose owner is gone is reported as orphaned on the first sweep", async (t) => {
  await scratchThroneHome(t);
  const sweeps = scratchPaneCourt();
  await registerScratchPaneFor(sweeps, SCRATCH_CLAUDE_PANE.paneId, FIRST_SWEEP_MS + 60 * MINUTE_MS);
  sweeps.liveAgentNames = [];
  const firstSweep = await sweeps.sweep();
  assert.equal(firstSweep.length, 1);
  assert.match(firstSweep[0].prompt, new RegExp(`pane w1:pS .*orphaned scratch pane, owner ${SCRATCH_PANE_OWNER}`));
  assert.deepEqual(await sweeps.sweep(), []);
});

test("an unnamed pane with no marker is still reported as before", async (t) => {
  await scratchThroneHome(t);
  const sweeps = court();
  sweeps.liveAgentNames = [SCRATCH_PANE_OWNER];
  await registerScratchPaneFor(sweeps, SCRATCH_CLAUDE_PANE.paneId, FIRST_SWEEP_MS + 60 * MINUTE_MS);
  assert.deepEqual(await sweeps.sweep(), []);
  const secondSweep = await sweeps.sweep();
  assert.equal(secondSweep.length, 1);
  assert.match(secondSweep[0].prompt, /herdr agent rename w1:pT stager-fable/);
});
