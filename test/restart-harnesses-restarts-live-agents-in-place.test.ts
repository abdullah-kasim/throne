import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { HARNESS_PROVENANCE_STATES, harnessProvenance } from "../src/herdr/harness-provenance.ts";
import type { HerdrAgent } from "../src/herdr/herdr-identity-contracts.ts";
import type { HerdrPaneProcessInfo } from "../src/herdr/herdr-inventory.service.ts";
import type { SpawnSpec } from "../src/agentdata/spawn-data-contracts.ts";
import { relaunchAgent, resumeAgentInItsTab } from "../src/restart-harnesses/restart-harnesses-relaunch.ts";
import {
  parseRestartHarnessesArguments,
  planRestarts,
  restartHarnesses,
  type RestartHarnessesDeps,
} from "../src/restart-harnesses/restart-harnesses-runtime.ts";
import { run, type DetachedRunDeps } from "../src/restart-harnesses/restart-harnesses-run.ts";
import { missingPhrases, readMarkdownSection, readSkillSource, unwrap } from "./skill-contract-test-helpers.ts";
import { installPinnedBun } from "./pinned-bun.support.ts";

const SELF_PANE = "w1:pSELF";
const VENDORED_BINARY = "/throne/vendor/node_modules/.bin/claude";

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
    configuredEfforts?: Record<string, number>;
    harnessProvenance?: RestartHarnessesDeps["harnessProvenance"];
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
    harnessProvenance:
      options.harnessProvenance ??
      (async () => ({ state: HARNESS_PROVENANCE_STATES.PINNED, executablePath: VENDORED_BINARY, argv: [] })),
    readAccountsConfig: () => null,
    configuredEffort: async (name, role) => options.configuredEfforts?.[role ?? name],
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
    listClaudeSessions: async () => [],
    processIsAlive: () => false,
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

test("restart-harnesses skips a pane whose herdr name is blank", () => {
  const roster = [agent({ name: "  ", paneId: "w1:pBlank" }), agent({ name: "stager-b" })];
  const { targets, skipped } = planRestarts(roster, undefined, ALL);
  assert.deepEqual(targets.map((target) => target.name), ["stager-b"]);
  assert.deepEqual(skipped.map((outcome) => [outcome.name, outcome.detail]), [["(claude) w1:pBlank", "unnamed pane"]]);
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
  assert.deepEqual(outcomes, [{ name: "stager-b", verdict: "restarted", detail: `resumed native session abc-123; running ${VENDORED_BINARY}` }]);
  assert.deepEqual(recorder.written, [{ name: "stager-b", spec: spawnSpec({ session_id: "abc-123" }) }]);
  assert.deepEqual(recorder.signals, [{ pid: 4242, signal: "SIGTERM" }]);
  assert.deepEqual(recorder.resumed, ["stager-b"]);
  assert.deepEqual(recorder.renamed, []);
});

test("a restart resumes a Stager at the effort its role is configured for", async () => {
  const stager = agent({ name: "stager-b", sessionId: "abc-123" });
  const { deps, recorder } = fakeDeps([stager], {
    afterRelaunch: [stager],
    configuredEfforts: { "stager-b": 3 },
  });
  const outcomes = await restartHarnesses(ALL, deps);
  assert.deepEqual(outcomes, [
    { name: "stager-b", verdict: "restarted", detail: `resumed native session abc-123 at effort 3 (was 1); running ${VENDORED_BINARY}` },
  ]);
  assert.deepEqual(recorder.written.at(-1), { name: "stager-b", spec: spawnSpec({ effort: 3 }) });
  assert.deepEqual(recorder.resumed, ["stager-b"]);
});

test("a restart asks for the Regent's effort by the regent role", async () => {
  const regent = agent({ name: "Regent", sessionId: "reg-1" });
  const { deps, recorder } = fakeDeps([regent], {
    afterRelaunch: [regent],
    configuredEfforts: { regent: 3 },
  });
  await restartHarnesses(ALL, deps);
  assert.deepEqual(recorder.written.at(-1)?.spec.effort, 3);
});

test("a relaunched pane that came back unnamed is renamed to the registered agent name", async () => {
  const stager = agent({ name: "stager-b" });
  const relaunched = agent({ paneId: stager.paneId, tabId: stager.tabId, name: undefined });
  const { deps, recorder } = fakeDeps([stager], { afterRelaunch: [relaunched] });
  const outcomes = await restartHarnesses(ALL, deps);
  assert.equal(outcomes[0]!.verdict, "restarted");
  assert.deepEqual(recorder.renamed, [{ paneId: stager.paneId, name: "stager-b" }]);
});

test("the resume that follows a stop also serves a pane whose harness has already exited, with no process to stop", async () => {
  const exited = agent({ name: "stager-b", paneId: "w1:pB" });
  const { deps, recorder } = fakeDeps([], { afterRelaunch: [{ ...exited, name: undefined }] });
  await deps.listAgents();
  await resumeAgentInItsTab("stager-b", exited.tabId, deps);
  assert.deepEqual(recorder.resumed, ["stager-b"]);
  assert.deepEqual(recorder.renamed, [{ paneId: "w1:pB", name: "stager-b" }]);
  assert.deepEqual(recorder.signals, []);
});

test("a pane switched to another model is resumed on that model, not the one it was spawned with", async () => {
  const stager = agent({ name: "stager-b", sessionId: "abc-123" });
  const { deps, recorder } = fakeDeps([stager], {
    afterRelaunch: [stager],
    specs: { "stager-b": spawnSpec({ model: "opus", session_id: "abc-123" }) },
    liveModels: { "stager-b": "fable" },
  });
  const outcomes = await restartHarnesses(ALL, deps);
  assert.equal(outcomes[0]!.detail, `resumed native session abc-123 on fable (was opus); running ${VENDORED_BINARY}`);
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

function detachedRunRecorder(isDetachedRun = false): { detachedRunDeps: DetachedRunDeps; handedOver: (readonly string[])[] } {
  const handedOver: (readonly string[])[] = [];
  return {
    handedOver,
    detachedRunDeps: {
      isDetachedRun: () => isDetachedRun,
      handOverToDetachedRun: async (args) => {
        handedOver.push(args);
        return "/home/lord/tmp/restart-harnesses.log";
      },
    },
  };
}

test("a real run that includes its own pane prints the log path and exits 0 without stopping anything", async () => {
  const { deps, recorder } = fakeDeps([agent({ name: "stager-a", paneId: SELF_PANE })]);
  const { detachedRunDeps, handedOver } = detachedRunRecorder();
  assert.equal(await run(["--force"], deps, detachedRunDeps), 0);
  assert.deepEqual(handedOver, [["--force"]]);
  assert.deepEqual(recorder.signals, []);
  assert.match(recorder.log.join(""), /\/home\/lord\/tmp\/restart-harnesses\.log/);
});

test("a detached run does not hand over again", async () => {
  const invoker = agent({ name: "stager-a", paneId: SELF_PANE });
  const { deps, recorder } = fakeDeps([invoker], { afterRelaunch: [invoker] });
  const { detachedRunDeps, handedOver } = detachedRunRecorder(true);
  assert.equal(await run([], deps, detachedRunDeps), 0);
  assert.deepEqual(handedOver, []);
  assert.deepEqual(recorder.resumed, ["stager-a"]);
});

test("a dry run stays in the foreground", async () => {
  const { deps, recorder } = fakeDeps([agent({ name: "stager-a", paneId: SELF_PANE })]);
  const { detachedRunDeps, handedOver } = detachedRunRecorder();
  assert.equal(await run(["--dry-run"], deps, detachedRunDeps), 0);
  assert.deepEqual(handedOver, []);
  assert.match(recorder.log.join(""), /stager-a — would stop pane/);
});

test("a restart of other agents only stays in the foreground and keeps its exit code", async () => {
  const invoker = agent({ name: "stager-a", paneId: SELF_PANE });
  const other = agent({ name: "stager-b" });
  const roster = [invoker, other];
  const { deps, recorder } = fakeDeps(roster, { afterRelaunch: roster });
  const { detachedRunDeps, handedOver } = detachedRunRecorder();
  assert.equal(await run(["--only", "stager-b"], deps, detachedRunDeps), 0);
  assert.deepEqual(recorder.resumed, ["stager-b"]);
  const failing = fakeDeps([invoker, agent({ name: "shadow-y", sessionId: undefined })]);
  assert.equal(await run(["--only", "shadow-y"], failing.deps, detachedRunDeps), 1);
  assert.deepEqual(handedOver, []);
});

test("a run with no invoking pane stays in the foreground", async () => {
  const stager = agent({ name: "stager-b" });
  const { deps, recorder } = fakeDeps([stager], { afterRelaunch: [stager] });
  const { detachedRunDeps, handedOver } = detachedRunRecorder();
  assert.equal(await run([], { ...deps, currentPaneId: async () => undefined }, detachedRunDeps), 0);
  assert.deepEqual(handedOver, []);
  assert.deepEqual(recorder.resumed, ["stager-b"]);
});

test("an agent relaunched on a binary other than the vendored one is reported as failed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "restart-provenance-"));
  const vendoredDirectory = path.join(directory, "vendor-bin");
  const vendoredBinary = path.join(directory, "vendored-claude");
  const nativeBinary = path.join(directory, "native", "claude");
  await mkdir(vendoredDirectory);
  await mkdir(path.dirname(nativeBinary));
  await writeFile(vendoredBinary, "");
  await writeFile(nativeBinary, "");
  await symlink(vendoredBinary, path.join(vendoredDirectory, "claude"));
  const stager = agent({ name: "stager-b" });
  const provenanceOf = (executable: string) => (paneId: string) =>
    harnessProvenance(paneId, {
      getPaneProcessInfo: async () => ({
        paneId,
        foregroundProcesses: [{ name: "claude", argv: [executable, "--resume", "x"], pid: 77 }],
      }),
      vendoredHarnessBinaryDirectory: vendoredDirectory,
    });
  try {
    const native = fakeDeps([stager], { afterRelaunch: [stager], harnessProvenance: provenanceOf(nativeBinary) });
    const outcomes = await restartHarnesses(ALL, native.deps);
    assert.equal(outcomes[0]!.verdict, "failed");
    assert.match(outcomes[0]!.detail, new RegExp(`relaunched on ${nativeBinary}`));
    assert.deepEqual(native.recorder.resumed, ["stager-b"]);

    const vendored = fakeDeps([stager], {
      afterRelaunch: [stager],
      harnessProvenance: provenanceOf(path.join(vendoredDirectory, "claude")),
    });
    const [outcome] = await restartHarnesses(ALL, vendored.deps);
    assert.equal(outcome!.verdict, "restarted");
    assert.match(outcome!.detail, new RegExp(`running ${path.join(vendoredDirectory, "claude")}`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an agent launched on its recorded custom executable is not reported as failed for not being on the vendored binary", async () => {
  const customExecutable = "/opt/custom-harness/claude";
  const stager = agent({ name: "stager-b" });
  const customSpec = { "stager-b": spawnSpec({ harness_executable: customExecutable }) };
  const runningCustomExecutable = (paneId: string) =>
    harnessProvenance(paneId, {
      getPaneProcessInfo: async () => ({
        paneId,
        foregroundProcesses: [{ name: "claude", argv: [customExecutable], pid: 77 }],
      }),
      vendoredHarnessBinaryDirectory: "/throne/vendor/node_modules/.bin",
    });

  const custom = fakeDeps([stager], { afterRelaunch: [stager], specs: customSpec, harnessProvenance: runningCustomExecutable });
  const [outcome] = await restartHarnesses(ALL, custom.deps);
  assert.equal(outcome!.verdict, "restarted");
  assert.match(outcome!.detail, new RegExp(`running ${customExecutable}`));

  const normal = fakeDeps([stager], { afterRelaunch: [stager], harnessProvenance: runningCustomExecutable });
  const [normalOutcome] = await restartHarnesses(ALL, normal.deps);
  assert.equal(normalOutcome!.verdict, "failed");
  assert.match(normalOutcome!.detail, new RegExp(`relaunched on ${customExecutable}`));

  const noHarness = fakeDeps([stager], {
    afterRelaunch: [stager],
    specs: customSpec,
    harnessProvenance: async () => ({ state: HARNESS_PROVENANCE_STATES.NO_HARNESS, executablePath: undefined, argv: [] }),
  });
  const [noHarnessOutcome] = await restartHarnesses(ALL, noHarness.deps);
  assert.equal(noHarnessOutcome!.verdict, "failed");
  assert.match(noHarnessOutcome!.detail, /shows no harness process/);
});

test("a pane with no harness after the relaunch is reported as failed", async () => {
  const stager = agent({ name: "stager-b" });
  const { deps } = fakeDeps([stager], {
    afterRelaunch: [stager],
    harnessProvenance: async () => ({ state: HARNESS_PROVENANCE_STATES.NO_HARNESS, executablePath: undefined, argv: [] }),
  });
  const outcomes = await restartHarnesses(ALL, deps);
  assert.equal(outcomes[0]!.verdict, "failed");
  assert.match(outcomes[0]!.detail, /shows no harness process/);
});

test("the relaunch works without a stop and keeps recording the session, the model and the effort", async () => {
  const exited = agent({ name: "stager-b", sessionId: "abc-123" });
  const { deps, recorder } = fakeDeps([exited], {
    specs: { "stager-b": spawnSpec({ model: "opus" }) },
    liveModels: { "stager-b": "fable" },
    configuredEfforts: { "stager-b": 3 },
  });
  const outcome = await relaunchAgent(exited, deps);
  assert.equal(outcome.verdict, "restarted");
  assert.equal(outcome.detail, `resumed native session abc-123 on fable (was opus) at effort 3 (was 1); running ${VENDORED_BINARY}`);
  assert.equal(recorder.written[0]!.spec.session_id, "abc-123");
  assert.equal(recorder.written[0]!.spec.model, "fable");
  assert.equal(recorder.written.at(-1)!.spec.effort, 3);
  assert.deepEqual(recorder.signals, []);
  assert.deepEqual(recorder.resumed, ["stager-b"]);
});

const HARNESS_SCRIPT = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const cli = spawn(process.execPath, JSON.parse(process.env.FIXTURE_CLI_ARGUMENTS), {
  env: { ...process.env, FIXTURE_HARNESS_PID: String(process.pid) },
  stdio: ["ignore", "pipe", "pipe"],
});
let printed = "";
cli.stdout.on("data", (chunk) => { printed += chunk; });
cli.stderr.on("data", (chunk) => { printed += chunk; });
cli.on("close", (exitCode) => writeFileSync(process.env.FIXTURE_CLI_RESULT, JSON.stringify({ exitCode, printed })));
setInterval(() => undefined, 1000);
`;

const DETACHED_RUN_DEADLINE_MS = 9_000;
const FINISHED_LINE = /^restart-harnesses: finished — .*$/m;

interface DetachedRunEvidence {
  cliResult: { exitCode: number; printed: string };
  harnessExitSignal: NodeJS.Signals | null;
  log: string;
  logPath: string;
}

let detachedRunEvidence: Promise<DetachedRunEvidence> | undefined;
const detachedRunHome = mkdtemp(path.join(tmpdir(), "restart-detached-")).then(async (home) => (await installPinnedBun(home), home));

async function logTextSoFar(logPath: string): Promise<string> {
  try {
    return await readFile(logPath, "utf8");
  } catch {
    return "";
  }
}

async function startDetachedRun(): Promise<DetachedRunEvidence> {
  const home = await detachedRunHome;
  const logPath = path.join(home, "tmp", "restart-harnesses.log");
  const cliResultPath = path.join(home, "cli-result.json");
  const harness = spawn(process.execPath, ["-e", HARNESS_SCRIPT], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: home,
      HERDR_PANE_ID: SELF_PANE,
      FIXTURE_CLI_RESULT: cliResultPath,
      FIXTURE_CLI_ARGUMENTS: JSON.stringify([
        "test/fixtures/restart-harnesses-from-a-pane.ts",
        "restart-harnesses",
        "--force",
      ]),
    },
  });
  const harnessExit = new Promise<NodeJS.Signals | null>((resolve) => {
    harness.on("exit", (_code, signal) => resolve(signal));
  });
  const deadline = Date.now() + DETACHED_RUN_DEADLINE_MS;
  try {
    while (!FINISHED_LINE.test(await logTextSoFar(logPath))) {
      assert.ok(Date.now() < deadline, "the detached run never wrote its closing line");
      await delay(50);
    }
  } finally {
    harness.kill("SIGKILL");
  }
  return {
    cliResult: JSON.parse(await readFile(cliResultPath, "utf8")),
    harnessExitSignal: await harnessExit,
    log: await readFile(logPath, "utf8"),
    logPath,
  };
}

function detachedRun(): Promise<DetachedRunEvidence> {
  detachedRunEvidence ??= startDetachedRun();
  return detachedRunEvidence;
}

after(async () => {
  await rm(await detachedRunHome, { recursive: true, force: true });
});

test("a restart that includes its own pane finishes after that pane's harness is stopped", async () => {
  const { cliResult, harnessExitSignal, log, logPath } = await detachedRun();
  assert.equal(cliResult.exitCode, 0);
  assert.ok(cliResult.printed.includes(logPath));
  assert.equal(harnessExitSignal, "SIGTERM");
  assert.match(log, /restarted\s+stager-self — resumed native session self-session/);
});

test("the invoking agent is still restarted last by the detached run", async () => {
  const { log } = await detachedRun();
  const restartedNames = [...log.matchAll(/restarted\s+(\S+) —/g)].map((match) => match[1]);
  assert.deepEqual(restartedNames, ["stager-other", "regent", "stager-self"]);
});

test("every outcome and a closing count reach the log", async () => {
  const { log } = await detachedRun();
  const lines = log.trimEnd().split("\n");
  assert.match(lines[0]!, /^=== restart-harnesses run \S+ --force ===$/);
  assert.match(log, /skipped\s+\(claude\) w1:pUnnamed — unnamed pane/);
  assert.match(log, /failed\s+shadow-without-session — herdr reports no native session id/);
  assert.equal(lines.at(-1), "restart-harnesses: finished — 3 restarted, 2 skipped, 1 failed");
});

const RUN_LINE = /^(===|restart-harnesses:|throne-startup:)/;
const SKILL_PLACEHOLDER = /<[^>]+>/;
const SKILL_EXAMPLE = /```text\n([\s\S]*?)```/;
const OTHER_AGENTS_ONLY = ["--only", "stager-other", "--only", "shadow-without-session"];

function runLines(printed: string): string[] {
  return printed.split("\n").filter((line) => RUN_LINE.test(line));
}

function fitsExample(line: string, example: string): boolean {
  const pattern = example
    .split(SKILL_PLACEHOLDER)
    .map((fixedText) => fixedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".+");
  return new RegExp(`^${pattern}$`).test(line);
}

function assertSkillShowsWhatWasPrinted(skill: string, heading: string, printed: string): void {
  const section = readMarkdownSection(skill, heading);
  const examples = SKILL_EXAMPLE.exec(section)?.[1]?.trimEnd().split("\n") ?? [];
  assert.notEqual(examples.length, 0, `the skill has no example under "${heading}"`);
  const lines = runLines(printed);
  assert.deepEqual(lines.filter((line) => !examples.some((example) => fitsExample(line, example))), [], heading);
  assert.deepEqual(examples.filter((example) => !lines.some((line) => fitsExample(line, example))), [], heading);
}

interface ForegroundRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runInForeground(home: string, args: readonly string[]): Promise<ForegroundRun> {
  const cli = spawn(
    process.execPath,
    ["test/fixtures/restart-harnesses-from-a-pane.ts", "restart-harnesses", ...args],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: home, HERDR_PANE_ID: SELF_PANE, FIXTURE_HARNESS_PID: String(process.pid) },
    },
  );
  let stdout = "";
  let stderr = "";
  cli.stdout.on("data", (chunk) => { stdout += chunk; });
  cli.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    cli.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

test("the restart skill says only what each kind of run really prints", async () => {
  const skill = await readSkillSource("restart-harnesses");
  const home = await mkdtemp(path.join(tmpdir(), "restart-foreground-"));
  after(() => rm(home, { recursive: true, force: true }));
  const [{ cliResult, log }, foreground, dryRun] = await Promise.all([
    detachedRun(),
    runInForeground(home, OTHER_AGENTS_ONLY),
    runInForeground(home, ["--dry-run"]),
  ]);

  assertSkillShowsWhatWasPrinted(skill, "### A real run with the invoking pane among its targets", cliResult.printed);
  assertSkillShowsWhatWasPrinted(skill, "### The log of that detached run", log);
  assertSkillShowsWhatWasPrinted(skill, "### A foreground run", foreground.stdout + foreground.stderr);
  assertSkillShowsWhatWasPrinted(skill, "### A dry run", dryRun.stdout + dryRun.stderr);

  assert.equal(cliResult.exitCode, 0);
  assert.equal(foreground.exitCode, 1);
  assert.equal(dryRun.exitCode, 0);
  assert.equal(await logTextSoFar(path.join(home, "tmp", "restart-harnesses.log")), "");
  for (const { stdout, stderr } of [foreground, dryRun]) {
    assert.doesNotMatch(stdout, /failed|skipped/);
    assert.match(stderr, /failed\s+shadow-without-session/);
    assert.match(stderr, /skipped\s+\(claude\)/);
  }
  assert.deepEqual(
    missingPhrases(unwrap(readMarkdownSection(skill, "### A foreground run")), [
      "no header and no closing line",
      "writes no log",
      "0 when nothing failed, 1 when any restart failed, 2 on a bad argument",
      "go to stderr",
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(unwrap(readMarkdownSection(skill, "### A dry run")), [
      "no header and no closing line",
      "writes no log",
      "the exit code stays 0",
    ]),
    [],
  );
});
