import assert from "node:assert/strict";
import { test } from "node:test";
import { HARNESS_PROVENANCE_STATES } from "../src/herdr/harness-provenance.ts";
import type { HerdrAgent } from "../src/herdr/herdr-identity-contracts.ts";
import type { HerdrForegroundProcess } from "../src/herdr/herdr-inventory.service.ts";
import { isSessionHostArgv, type ClaudeSessionEntry } from "../src/restart-harnesses/claude-session-listing.ts";
import {
  restartHarnesses,
  type RestartHarnessesDeps,
} from "../src/restart-harnesses/restart-harnesses-runtime.ts";

const VENDORED_BINARY = "/throne/vendor/node_modules/.bin/claude";
const SESSION_ID = "4b9e27c1-6d3a-4f80-9e15-a27c3d8f0b64";
const SESSION_PID = 41007;
const HOST_PID = 41003;
const VIEWER_PID = 52019;
const VIEWER: HerdrForegroundProcess = { name: "claude", argv: [VENDORED_BINARY, "attach", "4b9e27c1"], pid: VIEWER_PID };

const backgroundAgent: HerdrAgent = {
  agent: "claude",
  agentStatus: "idle",
  cwd: "/tmp/cwd",
  focused: false,
  name: "stager-back",
  paneId: "w1:pBack",
  tabId: "tab-back",
  terminalId: "term-back",
  sessionId: SESSION_ID,
};

interface BackgroundHost {
  deps: RestartHarnessesDeps;
  signals: { pid: number; signal: NodeJS.Signals }[];
  resumed: string[];
  renamed: { paneId: string; name: string }[];
  log: string[];
  warn: string[];
  listingReads: number;
}

function backgroundHost(options: {
  sessionSurvives?: boolean;
  viewerAfterResume?: boolean;
  resumeFails?: boolean;
  processOutlivesListing?: boolean;
  listingFails?: boolean;
  foregroundHarness?: HerdrForegroundProcess;
  harness?: string;
} = {}): BackgroundHost {
  const host: Omit<BackgroundHost, "deps"> = { signals: [], resumed: [], renamed: [], log: [], warn: [], listingReads: 0 };
  const agent: HerdrAgent = { ...backgroundAgent, agent: options.harness ?? "claude" };
  const paneProcess = options.foregroundHarness ?? VIEWER;
  let sessionRunning = true;
  let sessionProcessRunning = true;
  let viewerRunning = true;
  let clock = 0;
  const session: ClaudeSessionEntry = { pid: SESSION_PID, sessionId: SESSION_ID, kind: "background", hostPid: HOST_PID };
  const deps: RestartHarnessesDeps = {
    listAgents: async () =>
      host.resumed.length > 0 && options.resumeFails === true
        ? [{ ...agent, name: undefined }]
        : [agent],
    currentPaneId: async () => "w1:pSELF",
    getPaneProcessInfo: async (paneId) => ({ paneId, foregroundProcesses: viewerRunning ? [paneProcess] : [] }),
    signalProcess: (pid, signal) => {
      host.signals.push({ pid, signal });
      if (pid === SESSION_PID && options.sessionSurvives !== true) {
        sessionRunning = false;
        if (options.processOutlivesListing !== true || signal === "SIGKILL") sessionProcessRunning = false;
      }
      if (pid === paneProcess.pid) viewerRunning = false;
    },
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    now: () => clock,
    readSpawnSpec: async () => ({ harness: options.harness ?? "claude", model: "opus", effort: 1, cwd: "/tmp/cwd", session_id: SESSION_ID }),
    writeSpawnSpec: async () => undefined,
    readLiveModel: async () => undefined,
    readHarnessRecord: async () => undefined,
    resume: async (name) => {
      host.resumed.push(name);
      if (options.resumeFails === true) throw new Error("the relaunched pane never showed a prompt");
    },
    harnessProvenance: async () => ({
      state: HARNESS_PROVENANCE_STATES.PINNED,
      executablePath: VENDORED_BINARY,
      argv: options.viewerAfterResume === true ? VIEWER.argv : [VENDORED_BINARY, "--resume", SESSION_ID],
    }),
    readAccountsConfig: () => null,
    configuredEffort: async () => undefined,
    renameAgent: async (paneId, name) => {
      host.renamed.push({ paneId, name });
    },
    acquireRegentRestartLock: async () => "token",
    releaseRegentRestartLock: async () => undefined,
    listClaudeSessions: async () => {
      host.listingReads += 1;
      if (options.listingFails === true) throw new Error("claude agents --json exited 1");
      return sessionRunning ? [session] : [];
    },
    processIsAlive: (pid) => (pid === SESSION_PID || pid === HOST_PID) && (sessionRunning || sessionProcessRunning),
    log: (message) => host.log.push(message),
    warn: (message) => host.warn.push(message),
  };
  return Object.assign(host, { deps }) as BackgroundHost;
}

const ALL = { dryRun: false, force: false, only: [] };

test("a pane whose foreground process is a viewer and whose session runs elsewhere is recognised as a background session", async () => {
  const host = backgroundHost();
  const [outcome] = await restartHarnesses(ALL, host.deps);
  assert.equal(outcome?.verdict, "restarted", outcome?.detail);
  assert.ok(host.signals.some((sent) => sent.pid === SESSION_PID), JSON.stringify(host.signals));
});

test("the stop of a background session is aimed at the session's process and its host", async () => {
  const host = backgroundHost();
  await restartHarnesses(ALL, host.deps);
  assert.deepEqual(host.signals.slice(0, 2), [
    { pid: SESSION_PID, signal: "SIGTERM" },
    { pid: HOST_PID, signal: "SIGTERM" },
  ]);
  assert.deepEqual(host.resumed, ["stager-back"]);
});

test("a background session still alive after the stop is a failed line and nothing is relaunched over it", async () => {
  const host = backgroundHost({ sessionSurvives: true });
  const [outcome] = await restartHarnesses(ALL, host.deps);
  assert.equal(outcome?.verdict, "failed");
  assert.match(outcome!.detail, new RegExp(`process ${SESSION_PID}\\) survived SIGTERM and SIGKILL`));
  assert.deepEqual(host.resumed, []);
  assert.ok(host.signals.some((sent) => sent.pid === SESSION_PID && sent.signal === "SIGKILL"));
});

test("a restart that fails after the relaunch leaves the pane carrying the agent's name", async () => {
  const host = backgroundHost({ resumeFails: true });
  const [outcome] = await restartHarnesses(ALL, host.deps);
  assert.equal(outcome?.verdict, "failed");
  assert.match(outcome!.detail, /never showed a prompt/);
  assert.deepEqual(host.renamed, [{ paneId: "w1:pBack", name: "stager-back" }]);
});

test("the relaunched binary is checked on the process that runs the session, not on a viewer", async () => {
  const host = backgroundHost({ viewerAfterResume: true });
  const [outcome] = await restartHarnesses(ALL, host.deps);
  assert.equal(outcome?.verdict, "failed");
  assert.match(outcome!.detail, /runs only a viewer/);
});

test("the dry run says background session on a background agent's line", async () => {
  const host = backgroundHost();
  await restartHarnesses({ ...ALL, dryRun: true }, host.deps);
  assert.deepEqual(host.log, [
    `restart-harnesses: restarted stager-back — background session; would stop session process ${SESSION_PID} and its host, stop the viewer in pane w1:pBack, and resume session ${SESSION_ID} in the foreground (dry run)\n`,
  ]);
  assert.deepEqual(host.signals, []);
});

test("the host of a background session is signalled even when it was the daemon's spare host", () => {
  assert.equal(
    isSessionHostArgv(["/home/user/.local/bin/claude", "bg-pty-host", "--bg-spare", "--bg-pty-host", "/tmp/cc-daemon-1000/abc/pty/spare.sock"]),
    true,
  );
  assert.equal(isSessionHostArgv(["/home/user/.local/bin/claude", "daemon", "run"]), false);
});

test("a background session counts as stopped only once its process has exited", async () => {
  const host = backgroundHost({ processOutlivesListing: true });
  const [outcome] = await restartHarnesses(ALL, host.deps);
  assert.equal(outcome?.verdict, "restarted", outcome?.detail);
  assert.ok(host.signals.some((sent) => sent.pid === SESSION_PID && sent.signal === "SIGKILL"), JSON.stringify(host.signals));
});

const FOREGROUND_CLAUDE: HerdrForegroundProcess = { name: "claude", argv: [VENDORED_BINARY, "--resume", SESSION_ID], pid: 3000 };
const FOREGROUND_CODEX: HerdrForegroundProcess = { name: "codex", argv: ["/throne/vendor/node_modules/.bin/codex", "resume"], pid: 3001 };

test("a codex agent restarts without consulting the Claude session list", async () => {
  const host = backgroundHost({ harness: "codex", foregroundHarness: FOREGROUND_CODEX });
  await restartHarnesses(ALL, host.deps);
  await restartHarnesses({ ...ALL, dryRun: true }, host.deps);
  assert.equal(host.listingReads, 0);
  assert.ok(host.signals.some((sent) => sent.pid === FOREGROUND_CODEX.pid), JSON.stringify(host.signals));
});

test("a foreground claude agent still restarts when the Claude session list cannot be read", async () => {
  const host = backgroundHost({ listingFails: true, foregroundHarness: FOREGROUND_CLAUDE });
  const [outcome] = await restartHarnesses(ALL, host.deps);
  assert.equal(outcome?.verdict, "restarted", outcome?.detail);
  assert.deepEqual(host.signals, [{ pid: FOREGROUND_CLAUDE.pid, signal: "SIGTERM" }]);
  assert.deepEqual(host.resumed, ["stager-back"]);
});

test("a viewer pane whose session list cannot be read fails without stopping anything", async () => {
  const host = backgroundHost({ listingFails: true });
  const [outcome] = await restartHarnesses(ALL, host.deps);
  assert.equal(outcome?.verdict, "failed");
  assert.match(outcome!.detail, /Claude session list could not be read \(claude agents --json exited 1\); nothing was stopped/);
  assert.deepEqual(host.signals, []);
  assert.deepEqual(host.resumed, []);
  await restartHarnesses({ ...ALL, dryRun: true }, host.deps);
  assert.match(host.warn.at(-1)!, /failed\s+stager-back — pane w1:pBack shows a claude attach viewer but the Claude session list could not be read/);
});
