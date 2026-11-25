import {
  AGENT_LIFECYCLE_STATES,
  type AgentStatusesRosterEntry,
} from "../agent-statuses/agent-statuses.types.ts";
import path from "node:path";
import {
  fileExists,
  readSpawnSpec,
  writeSpawnSpec,
  type SpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import {
  findStagerTheCourtWouldReuse,
  type ReusableStager,
} from "../alpha-autoscale/reusable-stager.ts";
import type { ResumeRegisteredAgentInRestoredTabDeps } from "../herdr/herdr-create.contracts.ts";
import { resumeRegisteredAgentInRestoredTab } from "../herdr/herdr-create.service.ts";
import { REAL_RESUME_REGISTERED_AGENT_DEPS } from "../herdr/herdr-creation-orchestration.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import { runHerdr } from "../herdr/herdr-client.ts";
import {
  parseReadText,
  type HerdrForegroundProcess,
} from "../herdr/herdr-inventory.service.ts";
import { executableName } from "../herdr/herdr-process-detection.ts";
import { exactLabelTabs } from "../herdr/herdr-restored-tab-inspection.ts";
import {
  getPaneProcessInfo,
  listAgents,
  listPanes,
  listTabs,
  renameAgent,
} from "../herdr/herdr-runtime.service.ts";
import {
  findRestoredAgentTab,
  type RestoredAgentTab,
  type RestoredAgentTabDeps,
} from "../herdr/restored-agent-tab.ts";
import { REGENT_NAME } from "../regent-state/regent-liveness.ts";
import { isResurrectLockHeld } from "../regent-state/regent-resurrect-lock.ts";
import {
  DESIRED_STATES,
  REGENT_DIR,
  readDesiredState,
  type DesiredState,
} from "../regent-state/regent-state.service.ts";
import {
  resumeAgentInItsTab,
  type ResumeInTabDeps,
} from "../restart-harnesses/restart-harnesses-relaunch.ts";
import { errorText } from "../shared-policy/error-text.ts";
import { THRONE_DATA_DIR } from "../shared-policy/throne-home.ts";
import { COURT_LIVENESS_HOSTED_WORKER_NAME } from "../throne-backend/court-liveness.hosted-worker.ts";
import {
  COURT_ROLE_LIVENESS,
  decideCourtLiveness,
} from "../throne-backend/court-liveness.ts";
import {
  REAL_RESUME_CONTRACT,
  resumeOrphan,
  type StartupResumeContract,
} from "../throne-startup/throne-startup-reconciliation.service.ts";
import {
  revivalHistoryOfSubject,
  revivalHistoryStoreUnder,
  revivalLimitIsReached,
  withLimitReported,
  withRevivalAt,
  type RevivalHistory,
  type RevivalHistoryStore,
} from "./agent-revival-history.ts";
import {
  sessionToResume,
  transcriptExists,
  type SessionToResumeDeps,
} from "./agent-session-to-resume.ts";

export const AGENT_REVIVAL_OUTCOMES = {
  REVIVED: "revived",
  WOULD_REVIVE: "would-revive",
  LEFT_TO_OWNER: "left-to-owner",
  LEFT_ALONE: "left-alone",
  SKIPPED: "skipped",
  LIMIT_REACHED: "limit-reached",
  FAILED: "failed",
} as const;

export const AGENT_REVIVAL_SKIP_REASONS = {
  REGENT_IS_DISMISSED: "the Regent is dismissed",
  HARNESS_STILL_RUNS: "a harness process still runs in its tab",
  TOLD_TO_EXIT: "it was told to exit",
  NO_RECORDED_SESSION: "its spawn record holds no native session to resume",
  PANE_IS_IN_USE: "its pane is not at a shell prompt with nothing typed",
  RESURRECT_LOCK_IS_HELD: "the resurrect lock is held, so the court is being brought back",
} as const;

export const TOLD_TO_EXIT_MARKER_BASENAME = "told-to-exit";

export const TAB_DISAPPEARED_BEFORE_THE_RESUME =
  "its tab disappeared before the harness could be started, and no tab is opened";

export type AgentRevivalOutcome = { readonly agentName: string } & (
  | {
      readonly kind:
        | typeof AGENT_REVIVAL_OUTCOMES.REVIVED
        | typeof AGENT_REVIVAL_OUTCOMES.WOULD_REVIVE;
      readonly paneId: string;
      readonly sessionId: string;
    }
  | {
      readonly kind: typeof AGENT_REVIVAL_OUTCOMES.LEFT_TO_OWNER;
      readonly owner: string;
    }
  | { readonly kind: typeof AGENT_REVIVAL_OUTCOMES.LEFT_ALONE }
  | {
      readonly kind:
        | typeof AGENT_REVIVAL_OUTCOMES.SKIPPED
        | typeof AGENT_REVIVAL_OUTCOMES.FAILED;
      readonly reason: string;
    }
  | {
      readonly kind: typeof AGENT_REVIVAL_OUTCOMES.LIMIT_REACHED;
      readonly alreadyReported: boolean;
    }
);

export interface AgentRevivalRequest {
  readonly dryRun: boolean;
  readonly rosterEntries: readonly AgentStatusesRosterEntry[];
}

export interface AgentRevivalDeps
  extends RestoredAgentTabDeps,
    SessionToResumeDeps {
  readonly readDesiredState: () => Promise<DesiredState>;
  readonly resurrectLockIsHeld: () => Promise<boolean>;
  readonly findStagerTheCourtWouldReuse: (
    liveAgentNames: readonly string[],
  ) => Promise<ReusableStager | null>;
  readonly readStyledPaneScreen: (paneId: string) => Promise<string>;
  readonly readSpawnSpec: (agentName: string) => Promise<SpawnSpec | null>;
  readonly writeSpawnSpec: (agentName: string, spec: SpawnSpec) => Promise<void>;
  readonly agentWasToldToExit: (agentName: string) => Promise<boolean>;
  readonly history: RevivalHistoryStore;
  readonly now: () => number;
  readonly restart: ResumeInTabDeps;
}

export function resumeContractThatNeverOpensATab(
  contract: StartupResumeContract,
  herdr: ResumeRegisteredAgentInRestoredTabDeps,
): StartupResumeContract {
  return {
    ...contract,
    resumeRegisteredAgentInRestoredTab: (agentName, options) =>
      resumeRegisteredAgentInRestoredTab(agentName, options, {
        ...herdr,
        startAgent: () => {
          throw new Error(TAB_DISAPPEARED_BEFORE_THE_RESUME);
        },
      }),
  };
}

async function readStyledScreenOfPaneWithoutHarness(
  paneId: string,
): Promise<string> {
  const { stdout } = await runHerdr([
    "pane",
    "read",
    paneId,
    "--source",
    "visible",
    "--format",
    "ansi",
  ]);
  return parseReadText(stdout);
}

export function agentWasToldToExitUnder(
  agentDataRoot: string,
): (agentName: string) => Promise<boolean> {
  return (agentName) =>
    fileExists(path.join(agentDataRoot, agentName, TOLD_TO_EXIT_MARKER_BASENAME));
}

export const REAL_AGENT_REVIVAL_DEPS: AgentRevivalDeps = {
  listTabs,
  listPanes,
  getPaneProcessInfo,
  readDesiredState: () => readDesiredState(),
  resurrectLockIsHeld: () => isResurrectLockHeld(REGENT_DIR),
  findStagerTheCourtWouldReuse: (liveAgentNames) =>
    findStagerTheCourtWouldReuse(liveAgentNames),
  readStyledPaneScreen: readStyledScreenOfPaneWithoutHarness,
  readSpawnSpec: (agentName) => readSpawnSpec(agentName),
  writeSpawnSpec: (agentName, spec) => writeSpawnSpec(agentName, spec),
  agentWasToldToExit: agentWasToldToExitUnder(THRONE_DATA_DIR),
  transcriptExists: (spawnSpec, sessionId) =>
    transcriptExists(spawnSpec, sessionId),
  history: revivalHistoryStoreUnder(),
  now: Date.now,
  restart: {
    resume: (agentName) =>
      resumeOrphan(
        agentName,
        resumeContractThatNeverOpensATab(
          REAL_RESUME_CONTRACT,
          REAL_RESUME_REGISTERED_AGENT_DEPS,
        ),
      ),
    listAgents: () => listAgents(),
    renameAgent: (paneId, agentName) => renameAgent(paneId, agentName),
  },
};

type AgentRevivalDecision =
  | { readonly kind: "settled"; readonly outcome: AgentRevivalOutcome }
  | { readonly kind: "limit-reached"; readonly history: RevivalHistory }
  | {
      readonly kind: "revive";
      readonly tab: RestoredAgentTab;
      readonly sessionId: string;
      readonly spawnSpecToRecord: SpawnSpec | null;
      readonly history: RevivalHistory;
    };

const SHELLS_THAT_ECHO_TYPED_TEXT_UNSTYLED = new Set(["bash", "sh"]);
const TEXT_STYLE_CHANGE = /\u001b\[[0-9;]*m/g;

function settled(outcome: AgentRevivalOutcome): AgentRevivalDecision {
  return { kind: "settled", outcome };
}

function skipped(agentName: string, reason: string): AgentRevivalDecision {
  return settled({
    agentName,
    kind: AGENT_REVIVAL_OUTCOMES.SKIPPED,
    reason,
  });
}

function leftToCourtLiveness(agentName: string): AgentRevivalDecision {
  return settled({
    agentName,
    kind: AGENT_REVIVAL_OUTCOMES.LEFT_TO_OWNER,
    owner: COURT_LIVENESS_HOSTED_WORKER_NAME,
  });
}

function isTheRegent(agentName: string): boolean {
  return sameAgentName(agentName, REGENT_NAME);
}

async function regentDecision(
  agentName: string,
  deps: AgentRevivalDeps,
): Promise<AgentRevivalDecision> {
  return (await deps.readDesiredState()) === DESIRED_STATES.DISMISSED
    ? skipped(agentName, AGENT_REVIVAL_SKIP_REASONS.REGENT_IS_DISMISSED)
    : leftToCourtLiveness(agentName);
}

function liveAgentNames(
  rosterEntries: readonly AgentStatusesRosterEntry[],
): string[] {
  return rosterEntries
    .filter((entry) => entry.lifecycle === AGENT_LIFECYCLE_STATES.LIVE)
    .map((entry) => entry.name);
}

async function courtLivenessBringsThisStagerBack(
  agentName: string,
  rosterEntries: readonly AgentStatusesRosterEntry[],
  deps: AgentRevivalDeps,
): Promise<boolean> {
  const liveness = decideCourtLiveness({
    desiredState: await deps.readDesiredState(),
    rosterEntries,
    rosterReadThrew: false,
  });
  if (
    liveness.regent !== COURT_ROLE_LIVENESS.LIVE ||
    liveness.stager !== COURT_ROLE_LIVENESS.MISSING
  ) {
    return false;
  }
  const stager = await deps.findStagerTheCourtWouldReuse(
    liveAgentNames(rosterEntries),
  );
  return stager !== null && sameAgentName(stager.name, agentName);
}

function isShellProcess(process: HerdrForegroundProcess): boolean {
  return SHELLS_THAT_ECHO_TYPED_TEXT_UNSTYLED.has(executableName(process.name));
}

function withoutTextStyleChanges(styledText: string): string {
  return styledText.replaceAll(TEXT_STYLE_CHANGE, "");
}

function lastWrittenStyledLine(styledScreen: string): string | undefined {
  return styledScreen
    .split("\n")
    .filter((line) => withoutTextStyleChanges(line).trim() !== "")
    .at(-1);
}

function nothingFollowsTheLastStyledText(
  styledLine: string | undefined,
): boolean {
  if (styledLine === undefined) return false;
  const styleChanges = [...styledLine.matchAll(TEXT_STYLE_CHANGE)];
  const lastStyleChange = styleChanges.at(-1);
  if (lastStyleChange === undefined) return false;
  const afterTheLastStyleChange = styledLine.slice(
    lastStyleChange.index + lastStyleChange[0].length,
  );
  return afterTheLastStyleChange.trim() === "";
}

async function paneIsAShellPromptWithNothingTyped(
  paneId: string,
  deps: AgentRevivalDeps,
): Promise<boolean> {
  const { foregroundProcesses } = await deps.getPaneProcessInfo(paneId);
  if (
    foregroundProcesses.length === 0 ||
    !foregroundProcesses.every(isShellProcess)
  ) {
    return false;
  }
  return nothingFollowsTheLastStyledText(
    lastWrittenStyledLine(await deps.readStyledPaneScreen(paneId)),
  );
}

function tabsCarryingTheNameDecision(
  agentName: string,
  tabCount: number,
): AgentRevivalDecision {
  return tabCount === 0
    ? settled({ agentName, kind: AGENT_REVIVAL_OUTCOMES.LEFT_ALONE })
    : skipped(agentName, `${tabCount} tabs carry its name`);
}

async function decideAgentRevival(
  agentName: string,
  rosterEntries: readonly AgentStatusesRosterEntry[],
  deps: AgentRevivalDeps,
): Promise<AgentRevivalDecision> {
  if (isTheRegent(agentName)) return regentDecision(agentName, deps);
  if (await deps.resurrectLockIsHeld()) {
    return skipped(agentName, AGENT_REVIVAL_SKIP_REASONS.RESURRECT_LOCK_IS_HELD);
  }
  const namedTabs = exactLabelTabs(await deps.listTabs(), agentName);
  if (namedTabs.length !== 1) {
    return tabsCarryingTheNameDecision(agentName, namedTabs.length);
  }
  if (namedTabs[0]!.paneCount !== 1) {
    return skipped(agentName, `its tab holds ${namedTabs[0]!.paneCount} panes`);
  }
  const tab = await findRestoredAgentTab(agentName, deps);
  if (tab === null) {
    return skipped(agentName, AGENT_REVIVAL_SKIP_REASONS.HARNESS_STILL_RUNS);
  }
  if (await courtLivenessBringsThisStagerBack(agentName, rosterEntries, deps)) {
    return leftToCourtLiveness(agentName);
  }
  if (await deps.agentWasToldToExit(agentName)) {
    return skipped(agentName, AGENT_REVIVAL_SKIP_REASONS.TOLD_TO_EXIT);
  }
  const spawnSpec = await deps.readSpawnSpec(agentName);
  const session =
    spawnSpec === null ? null : await sessionToResume(spawnSpec, tab.paneId, deps);
  if (spawnSpec === null || session === null) {
    return skipped(agentName, AGENT_REVIVAL_SKIP_REASONS.NO_RECORDED_SESSION);
  }
  const resumedSpawnSpec = { ...spawnSpec, session_id: session.sessionId };
  const history = revivalHistoryOfSubject(
    await deps.history.read(agentName),
    JSON.stringify({ ...tab, spawnSpec: resumedSpawnSpec }),
  );
  if (revivalLimitIsReached(history, deps.now())) {
    return { kind: "limit-reached", history };
  }
  if (!(await paneIsAShellPromptWithNothingTyped(tab.paneId, deps))) {
    return skipped(agentName, AGENT_REVIVAL_SKIP_REASONS.PANE_IS_IN_USE);
  }
  return {
    kind: "revive",
    tab,
    sessionId: session.sessionId,
    spawnSpecToRecord: session.recoveredFromHerdr ? resumedSpawnSpec : null,
    history,
  };
}

async function reportRevivalLimitOnce(
  agentName: string,
  history: RevivalHistory,
  request: AgentRevivalRequest,
  deps: AgentRevivalDeps,
): Promise<AgentRevivalOutcome> {
  if (!request.dryRun && !history.limitWasReported) {
    await deps.history.write(agentName, withLimitReported(history));
  }
  return {
    agentName,
    kind: AGENT_REVIVAL_OUTCOMES.LIMIT_REACHED,
    alreadyReported: history.limitWasReported,
  };
}

export async function reviveAgentInItsTab(
  agentName: string,
  request: AgentRevivalRequest,
  deps: AgentRevivalDeps = REAL_AGENT_REVIVAL_DEPS,
): Promise<AgentRevivalOutcome> {
  const decision = await decideAgentRevival(
    agentName,
    request.rosterEntries,
    deps,
  );
  if (decision.kind === "settled") return decision.outcome;
  if (decision.kind === "limit-reached") {
    return reportRevivalLimitOnce(agentName, decision.history, request, deps);
  }
  const revival = {
    agentName,
    paneId: decision.tab.paneId,
    sessionId: decision.sessionId,
  };
  if (request.dryRun) {
    return { ...revival, kind: AGENT_REVIVAL_OUTCOMES.WOULD_REVIVE };
  }
  if (decision.spawnSpecToRecord !== null) {
    await deps.writeSpawnSpec(agentName, decision.spawnSpecToRecord);
  }
  await deps.history.write(
    agentName,
    withRevivalAt(decision.history, deps.now()),
  );
  try {
    await resumeAgentInItsTab(agentName, decision.tab.tabId, deps.restart);
  } catch (error) {
    return {
      agentName,
      kind: AGENT_REVIVAL_OUTCOMES.FAILED,
      reason: errorText(error),
    };
  }
  return { ...revival, kind: AGENT_REVIVAL_OUTCOMES.REVIVED };
}
