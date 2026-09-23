import assert from "node:assert/strict";
import { test } from "node:test";

import type { HerdrAgent } from "../src/herdr/herdr-identity-contracts.ts";
import type { HerdrPaneProcessInfo } from "../src/herdr/herdr-inventory.service.ts";
import type { SpawnSpec } from "../src/agentdata/spawn-data-contracts.ts";
import {
  parseRestartHarnessesArguments,
  planRestarts,
  restartHarnesses,
  run,
  type RestartHarnessesDeps,
} from "../src/restart-harnesses/restart-harnesses-runtime.ts";

const SELF_PANE = "w1:pSELF";

function agent(overrides: Partial<HerdrAgent> & { name?: string }): HerdrAgent {
  const paneId = overrides.paneId ?? `pane-${overrides.name ?? "unnamed"}`;
  return {
    agent: "claude",
    agentStatus: "idle",
    cwd: "/tmp/cwd",
    focused: false,
    paneId,
    tabId: `tab-${paneId}`,
    terminalId: `term-${paneId}`,
    sessionId: `session-${overrides.name ?? "unnamed"}`,
    ...overrides,
  };
}

function spawnSpec(overrides: Partial<SpawnSpec> = {}): SpawnSpec {
  return { harness: "claude", model: "opus", effort: 1, cwd: "/tmp/cwd", ...overrides };
}

interface Recorder {
  signals: { pid: number; signal: NodeJS.Signals }[];
  written: { name: string; spec: SpawnSpec }[];
  resumed: string[];
  renamed: { paneId: string; name: string }[];
  lockAcquired: number;
  lockReleased: string[];
  log: string[];
  warn: string[];
}

function fakeDeps(
  roster: HerdrAgent[],
  options: {
    afterRelaunch?: HerdrAgent[];
    harnessSurvives?: boolean;
    specs?: Record<string, SpawnSpec | null>;
    lockToken?: string | null;
    liveModels?: Record<string, string | undefined>;
    harnessRecords?: Record<string, string | undefined>;
  } = {},
): { deps: RestartHarnessesDeps; recorder: Recorder } {
  const recorder: Recorder = { signals: [], written: [], resumed: [], renamed: [], lockAcquired: 0, lockReleased: [], log: [], warn: [] };
  const stoppedPanes = new Set<string>();
  let lastQueriedPaneId: string | undefined;
  let clock = 0;
  const processInfo = (paneId: string): HerdrPaneProcessInfo => {
    lastQueriedPaneId = paneId;
    return {
      paneId,
      foregroundProcesses:
        stoppedPanes.has(paneId) && options.harnessSurvives !== true
          ? []
          : [{ name: "2.1.268", argv: ["claude", "--resume", "x"], pid: 4242 }],
    };
  };
  let listed = 0;
  const deps: RestartHarnessesDeps = {
    listAgents: async () => {
      listed += 1;
      return listed === 1 || options.afterRelaunch === undefined ? roster : options.afterRelaunch;
    },
    currentPaneId: async () => SELF_PANE,
    getPaneProcessInfo: async (paneId) => processInfo(paneId),
    signalProcess: (pid, signal) => {
      recorder.signals.push({ pid, signal });
      if (lastQueriedPaneId !== undefined) stoppedPanes.add(lastQueriedPaneId);
    },
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    now: () => clock,
    readSpawnSpec: async (name) => (options.specs !== undefined && name in options.specs ? options.specs[name]! : spawnSpec()),
    writeSpawnSpec: async (name, spec) => {
      recorder.written.push({ name, spec });
    },
    readLiveModel: async (candidate) => options.liveModels?.[candidate.name ?? ""],
    readHarnessRecord: async (name) => options.harnessRecords?.[name],
    resume: async (name) => {
      recorder.resumed.push(name);
    },
    renameAgent: async (paneId, name) => {
      recorder.renamed.push({ paneId, name });
    },
    acquireRegentRestartLock: async () => {
      recorder.lockAcquired += 1;
      return options.lockToken === undefined ? "token-1" : options.lockToken;
    },
    releaseRegentRestartLock: async (token) => {
      recorder.lockReleased.push(token);
    },
    log: (message) => recorder.log.push(message),
    warn: (message) => recorder.warn.push(message),
  };
  return { deps, recorder };
}

const ALL = { dryRun: false, force: false, only: [] };

test("the plan skips unnamed panes and working agents, includes the invoker, and orders the Regent then the invoker last", () => {
  const roster = [
    agent({ name: "regent" }),
    agent({ name: "stager-a", paneId: SELF_PANE, agentStatus: "working" }),
    agent({ name: "alpha-x", agentStatus: "working" }),
    agent({ paneId: "w1:pZ" }),
    agent({ name: "stager-b" }),
  ];
  const { targets, skipped } = planRestarts(roster, SELF_PANE, ALL);
  assert.deepEqual(targets.map((target) => target.name), ["stager-b", "regent", "stager-a"]);
  assert.deepEqual(
    skipped.map((outcome) => [outcome.name, outcome.detail.split(";")[0]]),
    [
      ["alpha-x", "status is working"],
      ["(claude) w1:pZ", "unnamed pane"],
    ],
  );
});

test("the invoker is included even while its own pane reports working status", () => {
  const roster = [agent({ name: "stager-a", paneId: SELF_PANE, agentStatus: "working" })];
  const { targets } = planRestarts(roster, SELF_PANE, ALL);
  assert.deepEqual(targets.map((target) => target.name), ["stager-a"]);
});

test("an invoker that is also the Regent is ordered last exactly once", () => {
  const roster = [agent({ name: "stager-b" }), agent({ name: "regent", paneId: SELF_PANE })];
  const { targets } = planRestarts(roster, SELF_PANE, ALL);
  assert.deepEqual(targets.map((target) => target.name), ["stager-b", "regent"]);
});

test("--force includes working agents and --only narrows to the named ones", () => {
  const roster = [agent({ name: "alpha-x", agentStatus: "working" }), agent({ name: "stager-b" })];
  assert.deepEqual(planRestarts(roster, undefined, { ...ALL, force: true }).targets.map((target) => target.name), ["alpha-x", "stager-b"]);
  assert.deepEqual(planRestarts(roster, undefined, { ...ALL, only: ["Stager-B"] }).targets.map((target) => target.name), ["stager-b"]);
});

test("a restart records the live session id, stops the harness, resumes, and keeps the name when the relaunch already carries it", async () => {
  const stager = agent({ name: "stager-b", sessionId: "abc-123" });
  const { deps, recorder } = fakeDeps([stager], { afterRelaunch: [stager] });
  const outcomes = await restartHarnesses(ALL, deps);
  assert.deepEqual(outcomes, [{ name: "stager-b", verdict: "restarted", detail: "resumed native session abc-123" }]);
  assert.deepEqual(recorder.written, [{ name: "stager-b", spec: spawnSpec({ session_id: "abc-123" }) }]);
  assert.deepEqual(recorder.signals, [{ pid: 4242, signal: "SIGTERM" }]);
  assert.deepEqual(recorder.resumed, ["stager-b"]);
  assert.deepEqual(recorder.renamed, []);
});

test("a relaunched pane that came back unnamed is renamed to the registered agent name", async () => {
  const stager = agent({ name: "stager-b" });
  const relaunched = agent({ paneId: stager.paneId, tabId: stager.tabId, name: undefined });
  const { deps, recorder } = fakeDeps([stager], { afterRelaunch: [relaunched] });
  const outcomes = await restartHarnesses(ALL, deps);
  assert.equal(outcomes[0]!.verdict, "restarted");
  assert.deepEqual(recorder.renamed, [{ paneId: stager.paneId, name: "stager-b" }]);
});

test("a pane switched to another model is resumed on that model, not the one it was spawned with", async () => {
  const stager = agent({ name: "stager-b", sessionId: "abc-123" });
  const { deps, recorder } = fakeDeps([stager], {
    afterRelaunch: [stager],
    specs: { "stager-b": spawnSpec({ model: "opus", session_id: "abc-123" }) },
    liveModels: { "stager-b": "fable" },
  });
  const outcomes = await restartHarnesses(ALL, deps);
  assert.equal(outcomes[0]!.detail, "resumed native session abc-123 on fable (was opus)");
  assert.equal(recorder.written.length, 1);
  assert.equal(recorder.written[0]!.spec.model, "fable");
  assert.equal(recorder.written[0]!.spec.session_id, "abc-123");
  assert.equal(typeof recorder.written[0]!.spec.switched_at, "string");
});

test("a pane still on its spawned model leaves the recorded model alone", async () => {
  const stager = agent({ name: "stager-b", sessionId: "abc-123" });
  const { deps, recorder } = fakeDeps([stager], {
    afterRelaunch: [stager],
    specs: { "stager-b": spawnSpec({ model: "opus", session_id: "abc-123" }) },
    liveModels: { "stager-b": "opus" },
  });
  await restartHarnesses(ALL, deps);
  assert.deepEqual(recorder.written, []);
});

test("a session id already on record is not rewritten", async () => {
  const stager = agent({ name: "stager-b", sessionId: "ABC-123" });
  const { deps, recorder } = fakeDeps([stager], { afterRelaunch: [stager], specs: { "stager-b": spawnSpec({ session_id: "abc-123" }) } });
  await restartHarnesses(ALL, deps);
  assert.deepEqual(recorder.written, []);
});

test("the Regent is restarted under the resurrect lock and the lock is released afterwards", async () => {
  const regent = agent({ name: "regent" });
  const { deps, recorder } = fakeDeps([regent], { afterRelaunch: [regent] });
  const outcomes = await restartHarnesses(ALL, deps);
  assert.equal(outcomes[0]!.verdict, "restarted");
  assert.equal(recorder.lockAcquired, 1);
  assert.deepEqual(recorder.lockReleased, ["token-1"]);
});

test("a held Regent lock skips the Regent instead of racing a resurrection", async () => {
  const { deps, recorder } = fakeDeps([agent({ name: "regent" })], { lockToken: null });
  const outcomes = await restartHarnesses(ALL, deps);
  assert.equal(outcomes[0]!.verdict, "skipped");
  assert.deepEqual(recorder.signals, []);
});

test("an agent without a native session id fails loudly and is not stopped", async () => {
  const noSession = agent({ name: "shadow-y", sessionId: undefined });
  const { deps, recorder } = fakeDeps([noSession]);
  const outcomes = await restartHarnesses(ALL, deps);
  assert.deepEqual(outcomes.map((outcome) => outcome.verdict), ["failed"]);
  assert.match(outcomes[0]!.detail, /no native session id/);
  assert.deepEqual(recorder.signals, []);
  assert.deepEqual(recorder.resumed, []);
});

test("the invoker restarts last, after the Regent, through the ordinary stop/resume/rename path", async () => {
  const regent = agent({ name: "regent", sessionId: "regent-session" });
  const invoker = agent({ name: "stager-a", paneId: SELF_PANE, sessionId: "self-session", agentStatus: "working" });
  const other = agent({ name: "stager-b", sessionId: "other-session" });
  const { deps, recorder } = fakeDeps([invoker, regent, other], { afterRelaunch: [invoker, regent, other] });
  const outcomes = await restartHarnesses(ALL, deps);
  assert.deepEqual(outcomes.map((outcome) => outcome.name), ["stager-b", "regent", "stager-a"]);
  assert.deepEqual(outcomes.map((outcome) => outcome.verdict), ["restarted", "restarted", "restarted"]);
  assert.deepEqual(recorder.resumed, ["stager-b", "regent", "stager-a"]);
  assert.match(recorder.log.join(""), /stopping the invoking harness's own pane/);
});

test("an agent with a live session id but no spawn.json ledger record gets one synthesized and is restarted", async () => {
  const handSeated = agent({ name: "regent", sessionId: "hand-seated-session", cwd: "/home/regent" });
  const { deps, recorder } = fakeDeps([handSeated], {
    afterRelaunch: [handSeated],
    specs: { regent: null },
    liveModels: { regent: "claude-fable-5-1" },
    harnessRecords: { regent: "claude" },
  });
  const outcomes = await restartHarnesses(ALL, deps);
  assert.equal(outcomes[0]!.verdict, "restarted");
  assert.match(outcomes[0]!.detail, /a spawn record was created from herdr and the live transcript/);
  assert.deepEqual(recorder.written, [
    {
      name: "regent",
      spec: {
        harness: "claude",
        model: "claude-fable-5-1",
        effort: 1,
        cwd: "/home/regent",
        session_id: "hand-seated-session",
        spawned_at: new Date(0).toISOString(),
      },
    },
  ]);
  assert.deepEqual(recorder.resumed, ["regent"]);
});

test("--dry-run reports the real failure reason for a target herdr reports no session id for", async () => {
  const { deps, recorder } = fakeDeps([agent({ name: "shadow-y", sessionId: undefined })]);
  await restartHarnesses({ ...ALL, dryRun: true }, deps);
  assert.deepEqual(recorder.signals, []);
  assert.deepEqual(recorder.resumed, []);
  assert.match(recorder.warn.join(""), /shadow-y — herdr reports no native session id/);
});

test("a harness that survives SIGTERM gets SIGKILL, and one that survives both is reported as failed", async () => {
  const { deps, recorder } = fakeDeps([agent({ name: "stager-b" })], { harnessSurvives: true });
  const outcomes = await restartHarnesses(ALL, deps);
  assert.equal(outcomes[0]!.verdict, "failed");
  assert.match(outcomes[0]!.detail, /survived SIGTERM and SIGKILL/);
  assert.deepEqual(recorder.signals.map((signal) => signal.signal), ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(recorder.resumed, []);
});

test("--dry-run prints the plan and touches nothing", async () => {
  const { deps, recorder } = fakeDeps([agent({ name: "stager-b" })]);
  await restartHarnesses({ ...ALL, dryRun: true }, deps);
  assert.deepEqual(recorder.signals, []);
  assert.deepEqual(recorder.resumed, []);
  assert.deepEqual(recorder.written, []);
  assert.match(recorder.log.join(""), /stager-b — would stop pane pane-stager-b and resume session session-stager-b \(dry run\)/);
});

test("run exits 2 on a bad argument, 1 when any restart failed, 0 otherwise", async () => {
  const { deps } = fakeDeps([agent({ name: "stager-b" })], { afterRelaunch: [agent({ name: "stager-b" })] });
  assert.equal(await run(["--bogus"], deps), 2);
  assert.equal(await run([], deps), 0);
  const failing = fakeDeps([agent({ name: "shadow-y", sessionId: undefined })]);
  assert.equal(await run([], failing.deps), 1);
});

test("argument parsing accepts repeated --only and rejects a dangling one", () => {
  assert.deepEqual(parseRestartHarnessesArguments(["--only", "a", "--only", "b", "--force"]), { dryRun: false, force: true, only: ["a", "b"] });
  assert.throws(() => parseRestartHarnessesArguments(["--only"]), /--only requires an agent name/);
});
