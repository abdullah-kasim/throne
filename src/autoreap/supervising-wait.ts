import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { sameAgentName } from '../herdr/herdr-identity-contracts.ts';
import { isAlphaRole, isStagerRole } from '../no-idling/idle-family.ts';

export type SupervisingWaitState = 'absent' | 'all-idle' | 'possibly-working';

/** Resolve whether an Alpha's live children are positively idle enough to inspect it. */
export function resolveSupervisingWaitState(
  alphaName: string,
  roster: readonly AgentStatusesRosterEntry[],
  supervisors: ReadonlyMap<string, string>,
): SupervisingWaitState {
  const liveChildren = roster.filter(
    (entry) =>
      entry.lifecycle === 'live' &&
      !isStagerRole(entry.role) &&
      sameAgentName(supervisors.get(entry.name), alphaName),
  );
  if (liveChildren.length === 0) return 'absent';
  return liveChildren.every((entry) => entry.liveStatus === 'idle')
    ? 'all-idle'
    : 'possibly-working';
}

/** Preserve ordinary candidates while failing Alpha claim evaluation closed on child state. */
export function canEvaluateReapabilityClaim(
  candidate: AgentStatusesRosterEntry,
  roster: readonly AgentStatusesRosterEntry[],
  supervisors: ReadonlyMap<string, string>,
): boolean {
  return (
    !isAlphaRole(candidate.role) ||
    resolveSupervisingWaitState(candidate.name, roster, supervisors) !== 'possibly-working'
  );
}
