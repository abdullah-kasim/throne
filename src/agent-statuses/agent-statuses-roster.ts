import {
  listLiveAgentStatuses,
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
import type { AgentStatus, ReadOptions } from '../herdr/herdr-inventory.service.ts';
import { agentStatusAcceptsInput } from '../herdr/herdr-inventory.service.ts';
import { readAgent } from '../herdr/herdr-runtime.service.ts';
import { liveBackgroundWork } from '../no-idling/idle-family.ts';
import { NO_IDLING_AGENT_READ_TIMEOUT_MS } from '../no-idling/no-idling-run.ts';

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

// The live pane tail read scanned for background-work chrome. `liveBackgroundWork`
// only looks at its own last-15-lines tail, so this window just needs enough
// margin to reliably contain that tail; it is deliberately far smaller than
// no-idling's 200-line marker-classification window because no message-marker
// parsing happens here.
const LIVE_BACKGROUND_WORK_READ_LINES = 30;

/** Whether a roster entry's raw herdr status is one a stale pane-idle read
 *  could be masking real background work behind — i.e. one `agentStatusAcceptsInput`
 *  already accepts. An entry whose status is already `working`/`blocked` needs no
 *  pane read: it cannot be under-reporting business, so checking it would only
 *  spend a read for no possible correction. */
function needsLiveBackgroundWorkCheck(entry: AgentStatusesRosterEntry): boolean {
  return (
    entry.lifecycle === AGENT_LIFECYCLE_STATES.LIVE &&
    entry.liveStatus !== undefined &&
    agentStatusAcceptsInput(entry.liveStatus)
  );
}

/** The live agent's pane tail, or undefined when the read fails or times out —
 *  callers must treat undefined as "no signal", never as "definitely idle". */
async function readLiveAgentPaneTail(
  name: string,
  readAgentPaneTail: (name: string, opts?: ReadOptions) => Promise<string>,
): Promise<string | undefined> {
  try {
    return await readAgentPaneTail(name, {
      source: 'recent',
      lines: LIVE_BACKGROUND_WORK_READ_LINES,
      timeoutMilliseconds: NO_IDLING_AGENT_READ_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
}

/** The roster's truthful live status: `working` when the pane tail shows live
 *  background work, otherwise the raw herdr status unchanged. */
function correctedLiveStatus(
  rawStatus: AgentStatus,
  runningWork: string | undefined,
): AgentStatus {
  return runningWork === undefined ? rawStatus : 'working';
}

/** One roster entry, corrected for live background work when its raw status
 *  needed checking; every other entry passes through unread and unchanged. */
async function withLiveBackgroundWorkCorrection(
  entry: AgentStatusesRosterEntry,
  readAgentPaneTail: (name: string, opts?: ReadOptions) => Promise<string>,
): Promise<AgentStatusesRosterEntry> {
  if (!needsLiveBackgroundWorkCheck(entry)) {
    return entry;
  }
  const paneTail = await readLiveAgentPaneTail(entry.name, readAgentPaneTail);
  const runningWork = paneTail === undefined ? undefined : liveBackgroundWork(paneTail);
  return {
    ...entry,
    liveStatus: correctedLiveStatus(entry.liveStatus!, runningWork),
  };
}

/** The roster with every live agent's status corrected for pane-visible
 *  background work `agent-statuses.command.ts` would otherwise report as
 *  falsely done/idle. */
async function applyLiveBackgroundWorkCorrections(
  roster: readonly AgentStatusesRosterEntry[],
  readAgentPaneTail: (name: string, opts?: ReadOptions) => Promise<string>,
): Promise<AgentStatusesRosterEntry[]> {
  return Promise.all(
    roster.map((entry) => withLiveBackgroundWorkCorrection(entry, readAgentPaneTail)),
  );
}

export interface AgentStatusesRosterDependencies {
  readonly listLiveAgentStatuses: () => Promise<LiveAgentStatus[]>;
  readonly listRegisteredAgentNames: () => Promise<string[]>;
  readonly listCompletedAgentNames: () => Promise<string[]>;
  readonly readAgentStatusRole: (name: string) => Promise<string>;
  readonly loadAgentStatusesRegentTitle: () => Promise<string>;
  readonly readAgentPaneTail: (name: string, opts?: ReadOptions) => Promise<string>;
}

const DEFAULT_ROSTER_DEPENDENCIES: AgentStatusesRosterDependencies = {
  listLiveAgentStatuses,
  listRegisteredAgentNames,
  listCompletedAgentNames,
  readAgentStatusRole,
  loadAgentStatusesRegentTitle,
  readAgentPaneTail: readAgent,
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
  return applyLiveBackgroundWorkCorrections(roster, dependencies.readAgentPaneTail);
}
