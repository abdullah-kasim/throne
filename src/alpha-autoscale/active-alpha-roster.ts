import { getAgentStatusesRoster } from '../agent-statuses/agent-statuses-roster.ts';
import { AGENT_LIFECYCLE_STATES } from '../agent-statuses/agent-statuses.types.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import {
  readBlockedMarker,
  type BlockedMarker,
} from '../agentdata/blocked-marker.service.ts';
import type { AlphaReadinessRecord } from '../keep-going/alpha-capacity.ts';

export interface ActiveAlphaCapacityInputs {
  readonly activeRecords: readonly AlphaReadinessRecord[];
  readonly mutatingTargets: readonly string[];
}

export interface ActiveAlphaCapacityDependencies {
  readonly getRoster: () => Promise<readonly AgentStatusesRosterEntry[]>;
  readonly readBlockedMarker: (name: string) => Promise<BlockedMarker | null>;
  readonly now: () => Date;
}

const DEFAULT_DEPENDENCIES: ActiveAlphaCapacityDependencies = {
  getRoster: getAgentStatusesRoster,
  readBlockedMarker,
  now: () => new Date(),
};

export async function readActiveAlphaCapacityInputs(
  dependencies: ActiveAlphaCapacityDependencies = DEFAULT_DEPENDENCIES,
): Promise<ActiveAlphaCapacityInputs> {
  const roster = await dependencies.getRoster();
  const observedAt = dependencies.now().toISOString();
  const liveAlphas = roster.filter(
    (entry) =>
      entry.role === 'Alpha' && entry.lifecycle === AGENT_LIFECYCLE_STATES.LIVE,
  );
  const markers = await Promise.all(
    liveAlphas.map((entry) => dependencies.readBlockedMarker(entry.name)),
  );
  const activeRecords: AlphaReadinessRecord[] = liveAlphas.map(
    (entry, index) => {
      const marker = markers[index];
      return {
        name: entry.name,
        role: 'Alpha',
        live: true,
        dependencyReady: true,
        executableWork: true,
        ...(marker === null || entry.liveStatus === undefined
          ? {}
          : {
              blockedEvidence: {
                blockedAt: marker.blockedAt,
                observedAt,
                liveStatus: entry.liveStatus,
              },
            }),
      };
    },
  );
  const mutatingTargets = liveAlphas
    .map((entry) => entry.cwd)
    .filter((cwd): cwd is string => typeof cwd === 'string' && cwd !== '');
  return { activeRecords, mutatingTargets };
}
