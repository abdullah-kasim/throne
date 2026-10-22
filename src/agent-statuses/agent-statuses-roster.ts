import {
  listLiveAgentStatusesAcrossSessions,
  type LiveAgentStatus,
} from './agent-statuses-herdr.ts';
import {
  listCompletedAgentNames,
  listRegisteredAgentNames,
  loadAgentStatusesRegentTitle,
  readAgentStatusRole,
} from './agent-statuses-registry.ts';
import {
  AGENT_LIFECYCLE_STATES,
  type AgentStatusesRosterEntry,
} from './agent-statuses.types.ts';
import type { AgentStatus } from '../herdr/herdr-inventory.service.ts';
import { agentStatusAcceptsInput } from '../herdr/herdr-inventory.service.ts';
import {
  HARNESS_BACKGROUND_WORK_KINDS,
  readHarnessBackgroundWork,
  type HarnessBackgroundWork,
} from '../process-inspection/harness-background-work.ts';

const REGENT_NAME = 'Regent';

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRegentName(name: string): boolean {
  return name.toLowerCase() === REGENT_NAME.toLowerCase();
}


export function compareAgentStatusesNames(
  left: string,
  right: string,
): number {
  const leftIsRegent = isRegentName(left);
  const rightIsRegent = isRegentName(right);
  if (leftIsRegent !== rightIsRegent) {
    return leftIsRegent ? -1 : 1;
  }
  const caseInsensitiveOrder = compareCodeUnits(
    left.toLowerCase(),
    right.toLowerCase(),
  );
  return caseInsensitiveOrder || compareCodeUnits(left, right);
}

function liveRosterEntry(
  agent: LiveAgentStatus,
  completedNames: ReadonlySet<string>,
  roles: ReadonlyMap<string, string>,
): AgentStatusesRosterEntry {
  const name = agent.tabLabel ?? agent.name ?? `(${agent.agent})`;
  return {
    name,
    lifecycle: AGENT_LIFECYCLE_STATES.LIVE,
    liveStatus: agent.agentStatus,
    reportLanded: completedNames.has(name),
    role: roles.get(name) || undefined,
    cwd: agent.cwd,
    paneId: agent.paneId,
    focused: agent.focused,
  };
}

function durableRosterEntry(
  name: string,
  completedNames: ReadonlySet<string>,
  roles: ReadonlyMap<string, string>,
): AgentStatusesRosterEntry {
  const reportLanded = completedNames.has(name);
  return {
    name,
    lifecycle: reportLanded
      ? AGENT_LIFECYCLE_STATES.COMPLETE
      : AGENT_LIFECYCLE_STATES.DEAD,
    reportLanded,
    role: roles.get(name) || undefined,
    focused: false,
  };
}

export function computeAgentStatusesRoster(
  liveAgents: readonly LiveAgentStatus[],
  registeredNames: readonly string[],
  completedNames: ReadonlySet<string> = new Set(),
  roles: ReadonlyMap<string, string> = new Map(),
): AgentStatusesRosterEntry[] {
  const exactLiveNames = new Set(
    liveAgents
    .map((agent) => agent.tabLabel ?? agent.name)
      .filter((name): name is string => name !== undefined),
  );
  return [
    ...liveAgents.map((agent) =>
      liveRosterEntry(agent, completedNames, roles),
    ),
    ...registeredNames
      .filter((name) => !exactLiveNames.has(name))
      .map((name) => durableRosterEntry(name, completedNames, roles)),
  ].sort((left, right) => compareAgentStatusesNames(left.name, right.name));
}

function needsLiveBackgroundWorkCheck(entry: AgentStatusesRosterEntry): boolean {
  return (
    entry.lifecycle === AGENT_LIFECYCLE_STATES.LIVE &&
    entry.liveStatus !== undefined &&
    agentStatusAcceptsInput(entry.liveStatus)
  );
}

function correctedLiveStatus(
  rawStatus: AgentStatus,
  backgroundWork: HarnessBackgroundWork,
): AgentStatus {
  return backgroundWork.kind === HARNESS_BACKGROUND_WORK_KINDS.RUNNING ? 'working' : rawStatus;
}

async function withLiveBackgroundWorkCorrection(
  entry: AgentStatusesRosterEntry,
  readBackgroundWork: (paneId: string) => Promise<HarnessBackgroundWork>,
): Promise<AgentStatusesRosterEntry> {
  if (!needsLiveBackgroundWorkCheck(entry) || entry.paneId === undefined) {
    return entry;
  }
  return {
    ...entry,
    liveStatus: correctedLiveStatus(entry.liveStatus!, await readBackgroundWork(entry.paneId)),
  };
}

async function applyLiveBackgroundWorkCorrections(
  roster: readonly AgentStatusesRosterEntry[],
  readBackgroundWork: (paneId: string) => Promise<HarnessBackgroundWork>,
): Promise<AgentStatusesRosterEntry[]> {
  return Promise.all(
    roster.map((entry) => withLiveBackgroundWorkCorrection(entry, readBackgroundWork)),
  );
}

export interface AgentStatusesRosterDependencies {
  readonly listLiveAgentStatuses: () => Promise<LiveAgentStatus[]>;
  readonly listRegisteredAgentNames: () => Promise<string[]>;
  readonly listCompletedAgentNames: () => Promise<string[]>;
  readonly readAgentStatusRole: (name: string) => Promise<string>;
  readonly loadAgentStatusesRegentTitle: () => Promise<string>;
  readonly readHarnessBackgroundWork: (paneId: string) => Promise<HarnessBackgroundWork>;
}

const DEFAULT_ROSTER_DEPENDENCIES: AgentStatusesRosterDependencies = {
  listLiveAgentStatuses: listLiveAgentStatusesAcrossSessions,
  listRegisteredAgentNames,
  listCompletedAgentNames,
  readAgentStatusRole,
  loadAgentStatusesRegentTitle,
  readHarnessBackgroundWork: (paneId) => readHarnessBackgroundWork(paneId),
};

export async function getAgentStatusesRoster(
  dependencies: AgentStatusesRosterDependencies = DEFAULT_ROSTER_DEPENDENCIES,
): Promise<AgentStatusesRosterEntry[]> {
  const [liveAgents, registeredNames, completedNames] = await Promise.all([
    dependencies.listLiveAgentStatuses(),
    dependencies.listRegisteredAgentNames(),
    dependencies.listCompletedAgentNames(),
  ]);
  const namesWithPossibleRoles = new Set([
    ...liveAgents
      .map((agent) => agent.tabLabel ?? agent.name)
      .filter((name): name is string => name !== undefined),
    ...registeredNames,
  ]);
  const [roleEntries, regentTitle] = await Promise.all([
    Promise.all(
      [...namesWithPossibleRoles].map(
        async (name) =>
          [name, await dependencies.readAgentStatusRole(name)] as const,
      ),
    ),
    dependencies.loadAgentStatusesRegentTitle(),
  ]);
  const roles = new Map(roleEntries);
  if (!roles.get(REGENT_NAME)) {
    roles.set(REGENT_NAME, regentTitle);
  }
  const roster = computeAgentStatusesRoster(
    liveAgents,
    registeredNames,
    new Set(completedNames),
    roles,
  );
  return applyLiveBackgroundWorkCorrections(roster, dependencies.readHarnessBackgroundWork);
}
