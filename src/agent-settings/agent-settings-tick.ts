import { getAgentStatusesRoster } from "../agent-statuses/agent-statuses-roster.ts";
import {
  AGENT_LIFECYCLE_STATES,
  type AgentStatusesRosterEntry,
} from "../agent-statuses/agent-statuses.types.ts";
import {
  readSpawnSpec,
  type SpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { listAgents } from "../herdr/herdr-runtime.service.ts";
import { REGENT_NAME } from "../regent-state/regent-liveness.ts";
import { errorText } from "../shared-policy/error-text.ts";
import { AsyncSerialGate } from "../transport/manual-trigger-route.ts";
import { REVIVALS_ALLOWED_PER_HOUR } from "./agent-revival-history.ts";
import {
  AGENT_REVIVAL_OUTCOMES,
  reviveAgentInItsTab,
  type AgentRevivalOutcome,
  type AgentRevivalRequest,
} from "./agent-revival.ts";
import {
  correctionsFor,
  desiredAgentSettings,
  harnessCommandFor,
  isAgentCorrectable,
} from "./agent-settings-decision.ts";
import {
  CORRECTION_TRIES_ALLOWED,
  correctionHistoryOfSubject,
  correctionHistoryStoreUnder,
  correctionTriesAreUsedUp,
  withGivingUpReported,
  withOneMoreTry,
  withValueRefused,
  type CorrectionHistory,
  type CorrectionHistoryStore,
} from "./agent-settings-retry-history.ts";
import {
  loadAgentSettingsConfig,
  type AgentSettingsConfig,
} from "./agent-settings-user-config.ts";
import {
  AGENT_ROLES,
  AGENT_SETTING_CORRECTION_KINDS,
  type ActualAgentSettings,
  type AgentColourByRole,
  type AgentSettingCorrection,
  type AgentSettingCorrectionKind,
  type DesiredAgentSettings,
  type RecordedAgent,
} from "./agent-settings.types.ts";
import {
  readClaudeSessionSettings,
  type ClaudeSessionSettings,
} from "./claude-session-settings.ts";
import {
  HARNESS_COMMAND_TYPING_OUTCOMES,
  typeHarnessCommandIntoIdleClaudePane,
  type HarnessCommandTypingResult,
} from "./harness-command-typing.ts";
import { claudeProjectsFolderOf } from "../account/agent-account.ts";

export interface AgentSettingsTickRequest {
  readonly dryRun: boolean;
}

export interface AgentSettingsTickDeps {
  readonly loadConfig: () => Promise<AgentSettingsConfig>;
  readonly readRoster: () => Promise<readonly AgentStatusesRosterEntry[]>;
  readonly listPaneAgents: () => Promise<readonly HerdrAgent[]>;
  readonly readSpawnSpec: (agentName: string) => Promise<SpawnSpec | null>;
  readonly readSessionSettings: (
    workingDirectory: string,
    sessionId: string | undefined,
    recordedAccount: string | undefined,
  ) => Promise<ClaudeSessionSettings>;
  readonly typeHarnessCommand: (
    agent: HerdrAgent,
    commandText: string,
  ) => Promise<HarnessCommandTypingResult>;
  readonly reviveAgent: (
    agentName: string,
    request: AgentRevivalRequest,
  ) => Promise<AgentRevivalOutcome>;
  readonly history: CorrectionHistoryStore;
}

export const REAL_AGENT_SETTINGS_TICK_DEPS: AgentSettingsTickDeps = {
  loadConfig: () => loadAgentSettingsConfig(undefined, String(Date.now())),
  readRoster: () => getAgentStatusesRoster(),
  listPaneAgents: () => listAgents(),
  readSpawnSpec: (agentName) => readSpawnSpec(agentName),
  readSessionSettings: (workingDirectory, sessionId, recordedAccount) =>
    readClaudeSessionSettings(workingDirectory, sessionId, claudeProjectsFolderOf(recordedAccount)),
  typeHarnessCommand: (agent, commandText) =>
    typeHarnessCommandIntoIdleClaudePane(agent, commandText),
  reviveAgent: (agentName, request) => reviveAgentInItsTab(agentName, request),
  history: correctionHistoryStoreUnder(),
};

export const AGENT_SETTINGS_CHECK_IS_SWITCHED_OFF =
  "agent-settings: the check is switched off (agentSettings.checkEnabled in config.user.ts); nothing was checked";
export const TAB_NAME_MATCHES_NO_RECORDED_AGENT =
  "its tab name matches no recorded agent; the tab is never renamed";
export const SPAWN_RECORD_IS_MISSING =
  "its spawn record is missing, so its harness is unknown; nothing is typed";
export const PANE_IS_NO_LONGER_LISTED =
  "herdr no longer lists its pane";

const HARNESS_OF_A_MISSING_SPAWN_RECORD = "unknown";

const LIVE_WITH_NOTHING_READ: ActualAgentSettings = {
  alive: true,
  colour: undefined,
  sessionName: undefined,
};

const SETTING_OF_CORRECTION_KIND: Readonly<
  Record<AgentSettingCorrectionKind, "colour" | "sessionName">
> = {
  [AGENT_SETTING_CORRECTION_KINDS.SET_COLOUR]: "colour",
  [AGENT_SETTING_CORRECTION_KINDS.SET_SESSION_NAME]: "sessionName",
};

const SPOKEN_SETTING: Readonly<Record<AgentSettingCorrectionKind, string>> = {
  [AGENT_SETTING_CORRECTION_KINDS.SET_COLOUR]: "colour",
  [AGENT_SETTING_CORRECTION_KINDS.SET_SESSION_NAME]: "name",
};

const CORRECTION_KINDS_IN_LINE_ORDER: readonly AgentSettingCorrectionKind[] = [
  AGENT_SETTING_CORRECTION_KINDS.SET_COLOUR,
  AGENT_SETTING_CORRECTION_KINDS.SET_SESSION_NAME,
];

interface TickInProgress {
  readonly request: AgentSettingsTickRequest;
  readonly deps: AgentSettingsTickDeps;
  readonly rosterEntries: readonly AgentStatusesRosterEntry[];
  readonly colourByRole: AgentColourByRole;
  readonly paneAgents: () => Promise<readonly HerdrAgent[]>;
  readonly launchCarriedTheSessionName: boolean;
}

interface CorrectionAttempt {
  readonly phrase: string;
  readonly history: CorrectionHistory;
}

const ticksRunOneAtATime = new AsyncSerialGate();

export function runAgentSettingsTick(
  request: AgentSettingsTickRequest,
  deps: AgentSettingsTickDeps = REAL_AGENT_SETTINGS_TICK_DEPS,
): Promise<string[]> {
  return ticksRunOneAtATime.run(() => linesOfOneTick(request, deps));
}

export const AGENT_IS_NOT_LISTED_AS_LIVE =
  "it is not listed as a live agent; nothing is typed";

const CORRECTING_FOR_REAL: AgentSettingsTickRequest = { dryRun: false };
const LAUNCH_CARRIED_THE_SESSION_NAME = true;
const SESSION_NAME_IS_KNOWN_ONLY_FROM_ITS_RECORD = false;

export function correctSettingsOfOneJustLaunchedAgent(
  agentName: string,
  deps: AgentSettingsTickDeps = REAL_AGENT_SETTINGS_TICK_DEPS,
): Promise<string> {
  return ticksRunOneAtATime.run(async () => {
    const tick = await tickInProgressOrWhyNot(
      CORRECTING_FOR_REAL,
      deps,
      LAUNCH_CARRIED_THE_SESSION_NAME,
    );
    if (typeof tick === "string") return tick;
    const entry = tick.rosterEntries.find(
      (listed) =>
        listed.lifecycle === AGENT_LIFECYCLE_STATES.LIVE &&
        sameAgentName(listed.name, agentName),
    );
    return entry === undefined
      ? `${agentName}: ${AGENT_IS_NOT_LISTED_AS_LIVE}`
      : `${entry.name}: ${await reportOfAgent(entry, tick)}`;
  });
}

async function tickInProgressOrWhyNot(
  request: AgentSettingsTickRequest,
  deps: AgentSettingsTickDeps,
  launchCarriedTheSessionName: boolean,
): Promise<TickInProgress | string> {
  const config = await deps.loadConfig();
  if (!config.checkEnabled) return AGENT_SETTINGS_CHECK_IS_SWITCHED_OFF;
  let rosterEntries: readonly AgentStatusesRosterEntry[];
  try {
    rosterEntries = await deps.readRoster();
  } catch (error) {
    return rosterCouldNotBeRead(errorText(error));
  }
  return {
    request,
    deps,
    rosterEntries,
    colourByRole: config.colourByRole,
    paneAgents: readAtMostOnce(deps.listPaneAgents),
    launchCarriedTheSessionName,
  };
}

async function linesOfOneTick(
  request: AgentSettingsTickRequest,
  deps: AgentSettingsTickDeps,
): Promise<string[]> {
  const tick = await tickInProgressOrWhyNot(
    request,
    deps,
    SESSION_NAME_IS_KNOWN_ONLY_FROM_ITS_RECORD,
  );
  if (typeof tick === "string") return [tick];
  const lines: string[] = [];
  for (const entry of tick.rosterEntries) {
    if (entry.lifecycle === AGENT_LIFECYCLE_STATES.COMPLETE) continue;
    lines.push(`${entry.name}: ${await reportOfAgent(entry, tick)}`);
  }
  return lines;
}

export function rosterCouldNotBeRead(reason: string): string {
  return `agent-settings: the agent roster could not be read, so nothing was changed: ${reason}`;
}

function readAtMostOnce<Value>(
  read: () => Promise<Value>,
): () => Promise<Value> {
  let pendingRead: Promise<Value> | undefined;
  return () => (pendingRead ??= read());
}

async function reportOfAgent(
  entry: AgentStatusesRosterEntry,
  tick: TickInProgress,
): Promise<string> {
  try {
    return entry.lifecycle === AGENT_LIFECYCLE_STATES.LIVE
      ? await settingsReportOfLiveAgent(entry, tick)
      : revivalReport(
          await tick.deps.reviveAgent(entry.name, {
            dryRun: tick.request.dryRun,
            rosterEntries: tick.rosterEntries,
          }),
        );
  } catch (error) {
    return `failed: ${errorText(error)}`;
  }
}

function recordedAgentOf(
  entry: AgentStatusesRosterEntry,
  spawnSpec: SpawnSpec | null,
): RecordedAgent {
  return {
    agentName: entry.name,
    role: sameAgentName(entry.name, REGENT_NAME)
      ? AGENT_ROLES.REGENT
      : entry.role,
    tabName: entry.name,
    harness: spawnSpec?.harness ?? HARNESS_OF_A_MISSING_SPAWN_RECORD,
  };
}

async function settingsReportOfLiveAgent(
  entry: AgentStatusesRosterEntry,
  tick: TickInProgress,
): Promise<string> {
  const spawnSpec = await tick.deps.readSpawnSpec(entry.name);
  const desired = desiredAgentSettings(
    recordedAgentOf(entry, spawnSpec),
    tick.colourByRole,
  );
  if (desired === undefined) return TAB_NAME_MATCHES_NO_RECORDED_AGENT;
  if (spawnSpec === null) return SPAWN_RECORD_IS_MISSING;
  if (!isAgentCorrectable(desired, LIVE_WITH_NOTHING_READ)) {
    return `runs ${desired.harness}, not Claude Code; nothing is typed`;
  }
  const recorded = await tick.deps.readSessionSettings(
    spawnSpec.cwd,
    spawnSpec.session_id,
    spawnSpec.account,
  );
  const actual: ActualAgentSettings = {
    ...LIVE_WITH_NOTHING_READ,
    ...recorded,
    sessionName:
      recorded.sessionName ?? sessionNameInEffectWithNoRecord(desired, tick),
  };
  return correctedSettingsReport(entry, spawnSpec, desired, actual, tick);
}

function sessionNameInEffectWithNoRecord(
  desired: DesiredAgentSettings,
  tick: TickInProgress,
): string | undefined {
  return tick.launchCarriedTheSessionName ? desired.sessionName : undefined;
}

async function correctedSettingsReport(
  entry: AgentStatusesRosterEntry,
  spawnSpec: SpawnSpec,
  desired: DesiredAgentSettings,
  actual: ActualAgentSettings,
  tick: TickInProgress,
): Promise<string> {
  const corrections = correctionsFor(desired, actual);
  const recordedHistory = (await tick.deps.history.read(entry.name)) ?? {};
  const nextHistory: Partial<
    Record<AgentSettingCorrectionKind, CorrectionHistory>
  > = {};
  const phrases: string[] = [];
  for (const kind of CORRECTION_KINDS_IN_LINE_ORDER) {
    const correction = corrections.find((wanted) => wanted.kind === kind);
    if (correction === undefined) {
      phrases.push(settingThatNeedsNoCorrection(kind, desired));
      continue;
    }
    const attempt = await attemptCorrection(
      entry,
      correction,
      correctionHistoryOfSubject(
        recordedHistory[kind],
        JSON.stringify({
          wanted: correction.name,
          sessionId: spawnSpec.session_id,
          paneId: entry.paneId,
        }),
      ),
      tick,
    );
    nextHistory[kind] = attempt.history;
    phrases.push(
      `${settingAsItIs(kind, actual)}, ${attempt.phrase}`,
    );
  }
  if (
    !tick.request.dryRun &&
    JSON.stringify(nextHistory) !== JSON.stringify(recordedHistory)
  ) {
    await tick.deps.history.write(entry.name, nextHistory);
  }
  return phrases.join("; ");
}

function settingThatNeedsNoCorrection(
  kind: AgentSettingCorrectionKind,
  desired: DesiredAgentSettings,
): string {
  const wanted = desired[SETTING_OF_CORRECTION_KIND[kind]];
  return wanted === undefined
    ? `its kind has no ${SPOKEN_SETTING[kind]}`
    : `${SPOKEN_SETTING[kind]} ${wanted} is right`;
}

function settingAsItIs(
  kind: AgentSettingCorrectionKind,
  actual: ActualAgentSettings,
): string {
  const found = actual[SETTING_OF_CORRECTION_KIND[kind]];
  return found === undefined
    ? `${SPOKEN_SETTING[kind]} is unknown`
    : `${SPOKEN_SETTING[kind]} is ${found}`;
}

async function attemptCorrection(
  entry: AgentStatusesRosterEntry,
  correction: AgentSettingCorrection,
  history: CorrectionHistory,
  tick: TickInProgress,
): Promise<CorrectionAttempt> {
  const notSet = `not set to ${correction.name}`;
  if (history.harnessRefusedTheValue) {
    return {
      phrase: `${notSet}: the harness refused that value, so it is not tried again`,
      history,
    };
  }
  if (correctionTriesAreUsedUp(history)) {
    return {
      phrase: history.givingUpWasReported
        ? `${notSet}: left alone after ${CORRECTION_TRIES_ALLOWED} tries`
        : `${notSet}: gave up after ${CORRECTION_TRIES_ALLOWED} tries`,
      history: withGivingUpReported(history),
    };
  }
  if (tick.request.dryRun) {
    return { phrase: `would be set to ${correction.name}`, history };
  }
  const paneAgent = (await tick.paneAgents()).find(
    (agent) => agent.paneId === entry.paneId,
  );
  if (paneAgent === undefined) {
    return { phrase: `${notSet}: ${PANE_IS_NO_LONGER_LISTED}`, history };
  }
  const typing = await tick.deps.typeHarnessCommand(
    paneAgent,
    harnessCommandFor(correction),
  );
  if (typing.outcome === HARNESS_COMMAND_TYPING_OUTCOMES.APPLIED) {
    const tried = withOneMoreTry(history);
    return {
      phrase: `set to ${correction.name} (try ${tried.tries} of ${CORRECTION_TRIES_ALLOWED})`,
      history: tried,
    };
  }
  if (typing.outcome === HARNESS_COMMAND_TYPING_OUTCOMES.PANE_CLOSED) {
    return { phrase: `${notSet}: ${PANE_IS_NO_LONGER_LISTED}`, history };
  }
  if (typing.outcome === HARNESS_COMMAND_TYPING_OUTCOMES.FAILED) {
    return {
      phrase: `${notSet}: failed: ${typing.reason}; that value is not tried again`,
      history: withValueRefused(history),
    };
  }
  return { phrase: `${notSet}: ${typing.outcome}`, history };
}

function revivalReport(outcome: AgentRevivalOutcome): string {
  switch (outcome.kind) {
    case AGENT_REVIVAL_OUTCOMES.REVIVED:
      return `dead; its harness was brought back in pane ${outcome.paneId}, resuming session ${outcome.sessionId}; colour and name follow once it is idle`;
    case AGENT_REVIVAL_OUTCOMES.WOULD_REVIVE:
      return `dead; its harness would be brought back in pane ${outcome.paneId}, resuming session ${outcome.sessionId}`;
    case AGENT_REVIVAL_OUTCOMES.LEFT_TO_OWNER:
      return `dead; left to the ${outcome.owner} worker, which owns it`;
    case AGENT_REVIVAL_OUTCOMES.LEFT_ALONE:
      return "dead with no tab; left alone";
    case AGENT_REVIVAL_OUTCOMES.SKIPPED:
      return `dead; not brought back: ${outcome.reason}`;
    case AGENT_REVIVAL_OUTCOMES.LIMIT_REACHED:
      return outcome.alreadyReported
        ? `dead; left alone after ${REVIVALS_ALLOWED_PER_HOUR} revivals in an hour`
        : `dead; gave up after ${REVIVALS_ALLOWED_PER_HOUR} revivals in an hour, left alone until its tab or record changes`;
    case AGENT_REVIVAL_OUTCOMES.FAILED:
      return `dead; bringing its harness back failed: ${outcome.reason}`;
  }
}
