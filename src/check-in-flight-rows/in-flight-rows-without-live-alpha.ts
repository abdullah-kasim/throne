import path from 'node:path';
import { getAgentStatusesRoster } from '../agent-statuses/agent-statuses-roster.ts';
import { readAgentSpawnStillStarting } from '../agent-statuses/agent-statuses-registry.ts';
import {
  AGENT_LIFECYCLE_STATES,
  type AgentStatusesRosterEntry,
} from '../agent-statuses/agent-statuses.types.ts';
import { fileExists, REAPED_DIR_NAME } from '../agentdata/ledger-data.service.ts';
import { listInFlightQueueItems } from '../regent-queue/regent-queue-lifecycle.ts';
import {
  openRegentQueueStore,
  type RegentQueueItemRow,
  type RegentQueueStore,
} from '../regent-queue/regent-queue.store.ts';
import { THRONE_DATA_DIR } from '../shared-policy/throne-home.ts';

export const MISSING_ALPHA_STATES = {
  DEAD: 'DEAD',
  COMPLETE: 'COMPLETE',
  REAPED: 'reaped',
  NEVER_REGISTERED: 'never registered',
} as const;

export type MissingAlphaState = (typeof MISSING_ALPHA_STATES)[keyof typeof MISSING_ALPHA_STATES];

export interface InFlightRowWithoutLiveAlpha {
  readonly objectiveCode: string;
  readonly agentName: string;
  readonly agentState: MissingAlphaState;
}

const NO_AGENT_RECORDED = '(none recorded)';

export interface InFlightRowEvidence {
  readonly rows: readonly RegentQueueItemRow[];
  readonly roster: readonly AgentStatusesRosterEntry[];
  readonly spawnIsStillStarting: (name: string) => Promise<boolean>;
  readonly ledgerIsArchived: (name: string) => Promise<boolean>;
}

function rosterEntryNamed(
  roster: readonly AgentStatusesRosterEntry[],
  name: string,
): AgentStatusesRosterEntry | undefined {
  return roster.find((entry) => entry.name === name);
}

async function stateOfMissingAlpha(
  rosterEntry: AgentStatusesRosterEntry | undefined,
  agentName: string,
  evidence: InFlightRowEvidence,
): Promise<MissingAlphaState> {
  if (rosterEntry?.lifecycle === AGENT_LIFECYCLE_STATES.COMPLETE) return MISSING_ALPHA_STATES.COMPLETE;
  if (rosterEntry?.lifecycle === AGENT_LIFECYCLE_STATES.DEAD) return MISSING_ALPHA_STATES.DEAD;
  if (await evidence.ledgerIsArchived(agentName)) return MISSING_ALPHA_STATES.REAPED;
  return MISSING_ALPHA_STATES.NEVER_REGISTERED;
}

async function findingForRow(
  row: RegentQueueItemRow,
  evidence: InFlightRowEvidence,
): Promise<InFlightRowWithoutLiveAlpha | undefined> {
  const agentName = row.agentName ?? NO_AGENT_RECORDED;
  const rosterEntry = rosterEntryNamed(evidence.roster, agentName);
  if (rosterEntry?.lifecycle === AGENT_LIFECYCLE_STATES.LIVE) return undefined;
  if (await evidence.spawnIsStillStarting(agentName)) return undefined;
  return {
    objectiveCode: row.objectiveCode ?? row.id,
    agentName,
    agentState: await stateOfMissingAlpha(rosterEntry, agentName, evidence),
  };
}

export async function findInFlightRowsWithoutLiveAlpha(
  evidence: InFlightRowEvidence,
): Promise<InFlightRowWithoutLiveAlpha[]> {
  const findings = await Promise.all(evidence.rows.map((row) => findingForRow(row, evidence)));
  return findings.filter((finding) => finding !== undefined);
}

export function formatInFlightRowWithoutLiveAlpha(finding: InFlightRowWithoutLiveAlpha): string {
  return `${finding.objectiveCode} (agent ${finding.agentName}, ${finding.agentState})`;
}

export interface InFlightRowCheckDependencies {
  readonly openStore: () => RegentQueueStore & { close(): void };
  readonly getRoster: () => Promise<AgentStatusesRosterEntry[]>;
  readonly dataDirectory: string;
  readonly now: () => number;
}

export const REAL_IN_FLIGHT_ROW_CHECK_DEPENDENCIES: InFlightRowCheckDependencies = {
  openStore: () => openRegentQueueStore(),
  getRoster: () => getAgentStatusesRoster(),
  dataDirectory: THRONE_DATA_DIR,
  now: Date.now,
};

function readInFlightRows(dependencies: InFlightRowCheckDependencies): RegentQueueItemRow[] {
  const store = dependencies.openStore();
  try {
    return listInFlightQueueItems(store);
  } finally {
    store.close();
  }
}

export async function readInFlightRowsWithoutLiveAlpha(
  dependencies: InFlightRowCheckDependencies = REAL_IN_FLIGHT_ROW_CHECK_DEPENDENCIES,
): Promise<InFlightRowWithoutLiveAlpha[]> {
  const rows = readInFlightRows(dependencies);
  if (rows.length === 0) return [];
  return findInFlightRowsWithoutLiveAlpha({
    rows,
    roster: await dependencies.getRoster(),
    spawnIsStillStarting: (name) =>
      readAgentSpawnStillStarting(name, dependencies.dataDirectory, dependencies.now),
    ledgerIsArchived: (name) =>
      fileExists(path.join(dependencies.dataDirectory, REAPED_DIR_NAME, name)),
  });
}
