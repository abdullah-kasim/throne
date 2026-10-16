import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AGENT_LIFECYCLE_STATES,
  type AgentStatusesRosterEntry,
} from "../agent-statuses/agent-statuses.types.ts";
import {
  readSpawnSpec,
  writeSpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import { findStagerTheCourtWouldReuse } from "../alpha-autoscale/reusable-stager.ts";
import type {
  ResumeRegisteredAgentInRestoredTabDeps,
  StartOptions,
} from "../herdr/herdr-create.contracts.ts";
import type { HerdrAgent } from "../herdr/herdr-identity-contracts.ts";
import type {
  HerdrForegroundProcess,
  HerdrPane,
  HerdrTab,
} from "../herdr/herdr-inventory.service.ts";
import { REGENT_NAME } from "../regent-state/regent-liveness.ts";
import {
  DESIRED_STATES,
  type DesiredState,
} from "../regent-state/regent-state.service.ts";
import {
  resumeOrphan,
  type StartupResumeContract,
} from "../throne-startup/throne-startup-reconciliation.service.ts";
import {
  REVIVAL_HISTORY_BASENAME,
  revivalHistoryStoreUnder,
} from "./agent-revival-history.ts";
import {
  resumeContractThatNeverOpensATab,
  reviveAgentInItsTab,
  type AgentRevivalDeps,
  type AgentRevivalOutcome,
} from "./agent-revival.ts";

const STYLE_RESET = "\u001b[0m";
const BOLD_YELLOW = "\u001b[1m\u001b[38;5;3m";
const BOLD_CYAN = "\u001b[1m\u001b[38;5;6m";
export const TWO_LINE_PROMPT_WITH_NOTHING_TYPED =
  `${STYLE_RESET}${BOLD_CYAN}alpha-ledger-01${STYLE_RESET} on main \r\n` +
  `${STYLE_RESET}${BOLD_YELLOW}[ 10:31:10 ]${STYLE_RESET} `;
export const UNSTYLED_DOLLAR_PROMPT = `${STYLE_RESET}theuser@host:~/work$ `;
export const SHELL_PROCESS: HerdrForegroundProcess = {
  name: "bash",
  argv: ["-bash"],
};
export const FIVE_MINUTES_IN_MILLISECONDS = 5 * 60 * 1000;

export function sessionIdNumbered(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

export interface PaneState {
  readonly paneId: string;
  readonly tabId: string;
  readonly label: string;
  foregroundProcesses: HerdrForegroundProcess[];
  styledScreen: string;
}

interface HarnessStart {
  readonly agentName: string;
  readonly paneId: string;
  readonly argv: string[];
}

export interface Court {
  readonly agentDataRoot: string;
  readonly deps: AgentRevivalDeps;
  readonly resumeContract: StartupResumeContract;
  readonly panes: PaneState[];
  readonly harnessStarts: HarnessStart[];
  readonly renames: { paneId: string; agentName: string }[];
  readonly tabsOpened: string[];
  desiredState: DesiredState;
  now: number;
  rosterEntries: AgentStatusesRosterEntry[];
  addShellPane: (label: string, tabId?: string) => PaneState;
  recordAgent: (
    agentName: string,
    sessionIndex: number | undefined,
    spawnedAt?: string,
  ) => Promise<void>;
  revive: (agentName: string, dryRun?: boolean) => Promise<AgentRevivalOutcome>;
}

function liveEntry(name: string): AgentStatusesRosterEntry {
  return {
    name,
    lifecycle: AGENT_LIFECYCLE_STATES.LIVE,
    reportLanded: false,
    focused: false,
  };
}

export async function court(): Promise<Court> {
  const agentDataRoot = await mkdtemp(
    path.join(os.tmpdir(), "throne-agent-revival-"),
  );
  const panes: PaneState[] = [];
  const harnessStarts: HarnessStart[] = [];
  const renames: { paneId: string; agentName: string }[] = [];
  const tabsOpened: string[] = [];
  const recordedAgentNames: string[] = [];

  const listTabs = async (): Promise<HerdrTab[]> =>
    [...new Set(panes.map((pane) => pane.tabId))].map((tabId) => ({
      tabId,
      label: panes.find((pane) => pane.tabId === tabId)!.label,
      paneCount: panes.filter((pane) => pane.tabId === tabId).length,
      workspaceId: "w1",
    }));
  const listPanes = async (): Promise<HerdrPane[]> =>
    panes.map((pane) => ({
      paneId: pane.paneId,
      tabId: pane.tabId,
      terminalId: `terminal-${pane.paneId}`,
      cwd: agentDataRoot,
    }));
  const getPaneProcessInfo = async (paneId: string) => ({
    paneId,
    foregroundProcesses: panes.find((pane) => pane.paneId === paneId)!
      .foregroundProcesses,
  });
  const relaunchedUnnamed = async (): Promise<HerdrAgent[]> =>
    panes
      .filter((pane) =>
        harnessStarts.some((start) => start.paneId === pane.paneId),
      )
      .map((pane) => ({
        agent: "claude",
        agentStatus: "idle",
        cwd: agentDataRoot,
        focused: false,
        paneId: pane.paneId,
        tabId: pane.tabId,
        terminalId: `terminal-${pane.paneId}`,
      }));
  const renameAgent = async (paneId: string, agentName: string) => {
    renames.push({ paneId, agentName });
  };
  const herdrBoundary: ResumeRegisteredAgentInRestoredTabDeps = {
    listTabs,
    listPanes,
    listNameOwners: async () => [],
    getPaneProcessInfo,
    renameAgent,
    startInTab: async (
      agentName: string,
      paneId: string,
      options: StartOptions,
    ) => {
      harnessStarts.push({ agentName, paneId, argv: options.argv });
      return paneId;
    },
    startAgent: async (agentName: string) => {
      tabsOpened.push(agentName);
      throw new Error("a tab was opened");
    },
    closePane: async () => {},
    sleep: async () => {},
  };
  const resumeContract = resumeContractThatNeverOpensATab(
    {
      readSpawnSpec: (agentName) => readSpawnSpec(agentName, agentDataRoot),
      resumeRegisteredAgentInRestoredTab: async () => {
        throw new Error("replaced by the contract that never opens a tab");
      },
      deliverOpeningPrompt: async () => {},
      pathExists: async () => true,
      throneRoot: agentDataRoot,
      log: () => {},
      warn: () => {},
    },
    herdrBoundary,
  );

  const state: Court = {
    agentDataRoot,
    panes,
    harnessStarts,
    renames,
    tabsOpened,
    resumeContract,
    desiredState: DESIRED_STATES.RUNNING,
    now: Date.parse("2026-10-13T00:00:00Z"),
    rosterEntries: [liveEntry(REGENT_NAME)],
    deps: {
      listTabs,
      listPanes,
      getPaneProcessInfo,
      readDesiredState: async () => state.desiredState,
      readForkedAgentNames: async () => new Set<string>(),
      findStagerTheCourtWouldReuse: (liveAgentNames) =>
        findStagerTheCourtWouldReuse(liveAgentNames, {
          listRegisteredAgentNames: async () => recordedAgentNames,
          isRegisteredStager: async (name) => name.startsWith("stager-"),
          readSpawnSpec: (name) => readSpawnSpec(name, agentDataRoot),
          readForkedAgentNames: async () => new Set<string>(),
          pathExists: async () => true,
          hasUncommittedChanges: async () => false,
        }),
      readStyledPaneScreen: async (paneId) =>
        panes.find((pane) => pane.paneId === paneId)!.styledScreen,
      readSpawnSpec: (agentName) => readSpawnSpec(agentName, agentDataRoot),
      history: revivalHistoryStoreUnder(agentDataRoot),
      now: () => state.now,
      restart: {
        resume: (agentName) => resumeOrphan(agentName, resumeContract),
        listAgents: relaunchedUnnamed,
        renameAgent,
      },
    },
    addShellPane: (label, tabId = `tab-${label}`) => {
      const pane: PaneState = {
        paneId: `pane-${panes.length + 1}`,
        tabId,
        label,
        foregroundProcesses: [SHELL_PROCESS],
        styledScreen: `Resume this session with:\r\nclaude --resume\r\n\r\n${TWO_LINE_PROMPT_WITH_NOTHING_TYPED}\r\n\r\n`,
      };
      panes.push(pane);
      return pane;
    },
    recordAgent: async (agentName, sessionIndex, spawnedAt) => {
      recordedAgentNames.push(agentName);
      await writeSpawnSpec(
        agentName,
        {
          harness: "claude",
          model: "opus",
          effort: 1,
          cwd: agentDataRoot,
          spawned_at: spawnedAt,
          session_id:
            sessionIndex === undefined
              ? undefined
              : sessionIdNumbered(sessionIndex),
        },
        agentDataRoot,
      );
    },
    revive: (agentName, dryRun = false) =>
      reviveAgentInItsTab(
        agentName,
        { dryRun, rosterEntries: state.rosterEntries },
        state.deps,
      ),
  };
  return state;
}

export async function courtWithOneDeadAgent(
  agentName: string,
): Promise<{ world: Court; pane: PaneState }> {
  const world = await court();
  await world.recordAgent(agentName, 1);
  return { world, pane: world.addShellPane(agentName) };
}

export async function revivalHistoryWasWritten(
  world: Court,
  agentName: string,
): Promise<boolean> {
  return (await readdir(path.join(world.agentDataRoot, agentName))).includes(
    REVIVAL_HISTORY_BASENAME,
  );
}
