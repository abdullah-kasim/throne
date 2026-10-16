import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AGENT_LIFECYCLE_STATES,
  type AgentStatusesRosterEntry,
} from "../agent-statuses/agent-statuses.types.ts";
import type { SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import type {
  AgentRevivalOutcome,
  AgentRevivalRequest,
} from "./agent-revival.ts";
import { correctionHistoryStoreUnder } from "./agent-settings-retry-history.ts";
import type { AgentSettingsTickDeps } from "./agent-settings-tick.ts";
import { DEFAULT_AGENT_SETTINGS_CONFIG } from "./agent-settings-user-config.ts";
import type { ClaudeSessionSettings } from "./claude-session-settings.ts";
import {
  HARNESS_COMMAND_TYPING_OUTCOMES,
  type HarnessCommandTypingResult,
} from "./harness-command-typing.ts";

export const REAL_RUN = { dryRun: false };
export const DRY_RUN = { dryRun: true };
export const APPLIED: HarnessCommandTypingResult = {
  outcome: HARNESS_COMMAND_TYPING_OUTCOMES.APPLIED,
};
export const SKIPPED_BUSY: HarnessCommandTypingResult = {
  outcome: HARNESS_COMMAND_TYPING_OUTCOMES.SKIPPED_BUSY,
};
const COLOUR_COMMAND = "/color";
const SESSION_NAME_COMMAND = "/rename";

export interface LiveAgentInTheCourt {
  readonly name: string;
  readonly role: string | undefined;
  readonly harness?: string;
  readonly isRecorded?: boolean;
  session: { colour: string | undefined; sessionName: string | undefined };
  sessionId?: string;
}

interface TypedCommand {
  readonly agentName: string;
  readonly commandText: string;
}

interface CourtOptions {
  readonly liveAgents?: LiveAgentInTheCourt[];
  readonly deadAgentRevivals?: Record<string, AgentRevivalOutcome>;
  readonly checkEnabled?: boolean;
  readonly typingResult?: (typed: TypedCommand) => HarnessCommandTypingResult;
  readonly commandsStick?: boolean;
  readonly agentWhoseSpawnRecordCannotBeRead?: string;
  readonly agentDataRoot?: string;
}

export interface Court {
  readonly deps: AgentSettingsTickDeps;
  readonly typed: TypedCommand[];
  readonly revivalRequests: AgentRevivalRequest[];
  readonly agentDataRoot: string;
  rosterReads: number;
}

function paneIdOf(agentName: string): string {
  return `pane-of-${agentName}`;
}

function workingDirectoryOf(agentName: string): string {
  return `/work/${agentName}`;
}

function liveRosterEntry(agent: LiveAgentInTheCourt): AgentStatusesRosterEntry {
  return {
    name: agent.name,
    lifecycle: AGENT_LIFECYCLE_STATES.LIVE,
    liveStatus: "idle",
    reportLanded: false,
    role: agent.role,
    cwd: workingDirectoryOf(agent.name),
    paneId: paneIdOf(agent.name),
    focused: false,
  };
}

function deadRosterEntry(agentName: string): AgentStatusesRosterEntry {
  return {
    name: agentName,
    lifecycle: AGENT_LIFECYCLE_STATES.DEAD,
    reportLanded: false,
    role: "Shadow",
    focused: false,
  };
}

function paneAgentOf(agent: LiveAgentInTheCourt): HerdrAgent {
  return {
    agent: agent.harness ?? HARNESS_NAMES.CLAUDE,
    name: agent.name,
    tabLabel: agent.name,
    agentStatus: "idle",
    cwd: workingDirectoryOf(agent.name),
    focused: false,
    paneId: paneIdOf(agent.name),
    tabId: `tab-of-${agent.name}`,
    terminalId: `terminal-of-${agent.name}`,
  };
}

function spawnSpecOf(agent: LiveAgentInTheCourt): SpawnSpec | null {
  if (agent.isRecorded === false) return null;
  return {
    harness: agent.harness ?? HARNESS_NAMES.CLAUDE,
    model: "opus",
    effort: 2,
    cwd: workingDirectoryOf(agent.name),
    session_id: agent.sessionId ?? `session-of-${agent.name}`,
  };
}

function applyTypedCommand(agent: LiveAgentInTheCourt, commandText: string) {
  const [command, value] = commandText.split(" ");
  if (command === COLOUR_COMMAND) agent.session.colour = value;
  if (command === SESSION_NAME_COMMAND) agent.session.sessionName = value;
}

export async function courtWith(options: CourtOptions): Promise<Court> {
  const liveAgents = options.liveAgents ?? [];
  const deadAgentRevivals = options.deadAgentRevivals ?? {};
  const agentDataRoot =
    options.agentDataRoot ??
    (await mkdtemp(path.join(os.tmpdir(), "agent-settings-tick-")));
  const liveAgentNamed = (agentName: string): LiveAgentInTheCourt =>
    liveAgents.find((agent) => agent.name === agentName)!;
  const court: Court = {
    typed: [],
    revivalRequests: [],
    agentDataRoot,
    rosterReads: 0,
    deps: {
      loadConfig: async () => ({
        ...DEFAULT_AGENT_SETTINGS_CONFIG,
        checkEnabled: options.checkEnabled ?? true,
      }),
      readRoster: async () => {
        court.rosterReads += 1;
        return [
          ...liveAgents.map(liveRosterEntry),
          ...Object.keys(deadAgentRevivals).map(deadRosterEntry),
        ];
      },
      listPaneAgents: async () => liveAgents.map(paneAgentOf),
      readSpawnSpec: async (agentName) => {
        if (agentName === options.agentWhoseSpawnRecordCannotBeRead) {
          throw new Error("the spawn record is unreadable");
        }
        return spawnSpecOf(liveAgentNamed(agentName));
      },
      readSessionSettings: async (
        workingDirectory,
      ): Promise<ClaudeSessionSettings> =>
        liveAgents.find(
          (agent) => workingDirectoryOf(agent.name) === workingDirectory,
        )!.session,
      typeHarnessCommand: async (paneAgent, commandText) => {
        const typed = { agentName: paneAgent.name!, commandText };
        court.typed.push(typed);
        const result = options.typingResult?.(typed) ?? APPLIED;
        if (result === APPLIED && options.commandsStick !== false) {
          applyTypedCommand(liveAgentNamed(typed.agentName), commandText);
        }
        return result;
      },
      reviveAgent: async (agentName, request) => {
        court.revivalRequests.push(request);
        return deadAgentRevivals[agentName]!;
      },
      history: correctionHistoryStoreUnder(agentDataRoot),
    },
  };
  return court;
}

export function shadowThatIsRight(name: string): LiveAgentInTheCourt {
  return {
    name,
    role: "Shadow",
    session: { colour: "purple", sessionName: name },
  };
}

export function shadowWithTheWrongColour(name: string): LiveAgentInTheCourt {
  return {
    ...shadowThatIsRight(name),
    session: { colour: "blue", sessionName: name },
  };
}

export function commandsTypedInto(court: Court, agentName: string): string[] {
  return court.typed
    .filter((typed) => typed.agentName === agentName)
    .map((typed) => typed.commandText);
}

export function lineOf(lines: readonly string[], agentName: string): string {
  return lines.find((line) => line.startsWith(`${agentName}: `))!;
}

