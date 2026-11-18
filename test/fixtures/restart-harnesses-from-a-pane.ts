import type { HerdrAgent } from "../../src/herdr/herdr-identity-contracts.ts";
import { HARNESS_PROVENANCE_STATES } from "../../src/herdr/harness-provenance.ts";
import {
  REAL_DEPS,
  type RestartHarnessesDeps,
} from "../../src/restart-harnesses/restart-harnesses-runtime.ts";
import { run } from "../../src/restart-harnesses/restart-harnesses-run.ts";
import {
  REAL_RESUME_CONTRACT,
  resumeOrphan,
} from "../../src/throne-startup/throne-startup-reconciliation.service.ts";

const invokingPaneId = process.env.HERDR_PANE_ID!;
const harnessProcessGroup = Number(process.env.FIXTURE_HARNESS_PID);
const recordedSessionId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function pane(name: string | undefined, paneId: string, sessionId: string | undefined): HerdrAgent {
  return {
    agent: "claude",
    agentStatus: "idle",
    cwd: process.cwd(),
    focused: false,
    paneId,
    tabId: `tab-${paneId}`,
    terminalId: `term-${paneId}`,
    ...(name === undefined ? {} : { name }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

const roster = [
  pane("stager-self", invokingPaneId, "self-session"),
  pane("regent", "w1:pRegent", "regent-session"),
  pane(undefined, "w1:pUnnamed", undefined),
  pane(undefined, "w1:pAlsoUnnamed", undefined),
  pane("shadow-without-session", "w1:pNoSession", undefined),
  pane("stager-other", "w1:pOther", "other-session"),
];

function harnessIsAlive(): boolean {
  try {
    process.kill(-harnessProcessGroup, 0);
    return true;
  } catch {
    return false;
  }
}

const stoppedPanes = new Set<string>();
let lastQueriedPaneId = "";

const deps: RestartHarnessesDeps = {
  ...REAL_DEPS,
  listAgents: async () => roster,
  getPaneProcessInfo: async (paneId) => {
    lastQueriedPaneId = paneId;
    const running = paneId === invokingPaneId ? harnessIsAlive() : !stoppedPanes.has(paneId);
    return {
      paneId,
      foregroundProcesses: running ? [{ name: "claude", argv: ["claude"], pid: harnessProcessGroup }] : [],
    };
  },
  signalProcess: (_pid, signal) => {
    if (lastQueriedPaneId === invokingPaneId) process.kill(-harnessProcessGroup, signal);
    stoppedPanes.add(lastQueriedPaneId);
  },
  readSpawnSpec: async () => ({ harness: "claude", model: "opus", effort: 1, cwd: process.cwd() }),
  writeSpawnSpec: async () => undefined,
  readLiveModel: async () => undefined,
  readHarnessRecord: async () => undefined,
  resume: (name) =>
    resumeOrphan(name, {
      ...REAL_RESUME_CONTRACT,
      readSpawnSpec: async () => ({ harness: "claude", model: "opus", effort: 1, cwd: process.cwd(), session_id: recordedSessionId }),
      resumeRegisteredAgentInRestoredTab: async () => ({ kind: "new-tab-launched" }),
      deliverOpeningPrompt: async () => undefined,
      pathExists: async () => true,
      readAccountsConfig: () => null,
    }),
  harnessProvenance: async () => ({
    state: HARNESS_PROVENANCE_STATES.PINNED,
    executablePath: "/throne/vendor/node_modules/.bin/claude",
    argv: [],
  }),
  readAccountsConfig: () => null,
  configuredEffort: async () => undefined,
  renameAgent: async () => undefined,
  acquireRegentRestartLock: async () => "lock-token",
  releaseRegentRestartLock: async () => undefined,
  processIsAlive: () => false,
  listClaudeSessions: async () =>
    process.argv.includes("--dry-run")
      ? [{ pid: 7777, sessionId: "other-session", kind: "background", hostPid: 7776 }]
      : [],
};

process.exitCode = await run(process.argv.slice(3), deps);
