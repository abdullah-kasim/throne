import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import {
  HARNESS_BACKGROUND_WORK_KINDS,
  type HarnessBackgroundWork,
} from '../process-inspection/harness-background-work.ts';
import type { ReadAgentState } from './blocked-marker-resolution.ts';

export type ReadRunningWork = (agentName: string) => Promise<HarnessBackgroundWork>;

const UNREADABLE_RUNNING_WORK: HarnessBackgroundWork = { kind: HARNESS_BACKGROUND_WORK_KINDS.UNKNOWN };

export function runningWorkDescription(work: HarnessBackgroundWork): string | undefined {
  return work.kind === HARNESS_BACKGROUND_WORK_KINDS.RUNNING ? work.description : undefined;
}

export function runningWorkOfRosterAgents(
  roster: readonly AgentStatusesRosterEntry[],
  readHarnessBackgroundWork: (paneId: string) => Promise<HarnessBackgroundWork>,
): ReadRunningWork {
  const paneIdByName = new Map(roster.map((entry) => [entry.name, entry.paneId]));
  return async (agentName) => {
    const paneId = paneIdByName.get(agentName);
    return paneId === undefined ? UNREADABLE_RUNNING_WORK : readHarnessBackgroundWork(paneId);
  };
}

export async function readWaitingOn(
  name: string,
  readAgentState: ReadAgentState,
): Promise<string | undefined> {
  try {
    return (await readAgentState(name)).waitingOn ?? undefined;
  } catch {
    return undefined;
  }
}

async function readWhatTheAgentWaitsOn(
  name: string,
  readRunningWork: ReadRunningWork,
  readAgentState: ReadAgentState,
): Promise<string | undefined> {
  return runningWorkDescription(await readRunningWork(name)) ?? readWaitingOn(name, readAgentState);
}

export async function withWhatEachAgentWaitsOn<Listed extends { readonly agent: string }>(
  listed: readonly Listed[],
  readRunningWork: ReadRunningWork,
  readAgentState: ReadAgentState,
): Promise<(Listed & { readonly backgroundWork?: string })[]> {
  const described: (Listed & { readonly backgroundWork?: string })[] = [];
  for (const entry of listed) {
    const backgroundWork = await readWhatTheAgentWaitsOn(entry.agent, readRunningWork, readAgentState);
    described.push(backgroundWork === undefined ? entry : { ...entry, backgroundWork });
  }
  return described;
}
