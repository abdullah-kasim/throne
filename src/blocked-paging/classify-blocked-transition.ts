import { sameAgentName } from '../herdr/herdr-identity-contracts.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';

export const BLOCKED_TRANSITION_VERDICTS = {
  FINE: 'blocked-and-fine',
  STUCK: 'blocked-and-stuck',
} as const;

/**
 * Positive allowlist of roles the blocked-paging check applies to. A role
 * outside this set (including absent/unknown) is excluded by default, not by
 * name -- a future role added tomorrow needs no update here to stay excluded.
 */
const BLOCKED_PAGING_APPLICABLE_ROLES: ReadonlySet<string> = new Set([
  'Alpha',
  'Shadow',
]);

export type BlockedTransitionVerdict =
  (typeof BLOCKED_TRANSITION_VERDICTS)[keyof typeof BLOCKED_TRANSITION_VERDICTS];

/**
 * The one shared predicate for "is this agent a supervisor with a live
 * child" — every caller deciding blocked-and-fine vs blocked-and-stuck goes
 * through this, never a re-derived inline check. A child counts as live when
 * its own roster entry has not exited (`lifecycle === 'live'`); a dead or
 * completed/reaped child does not keep its supervisor's blocked state fine.
 */
export function hasLiveChildren(
  agent: string,
  roster: readonly AgentStatusesRosterEntry[],
  supervisors: ReadonlyMap<string, string>,
): boolean {
  return roster.some(
    (entry) =>
      entry.lifecycle === 'live' &&
      sameAgentName(supervisors.get(entry.name), agent),
  );
}

/**
 * Classifies an agent's `blocked` transition as BLOCKED-AND-FINE (a
 * supervisor with a live child — normal, suppress paging) or
 * BLOCKED-AND-STUCK (everyone else, including a childless Alpha and any
 * Shadow, which never has children — page the Regent). Only Alpha/Shadow are
 * subject to this check at all -- any other role, or a missing/unknown role,
 * is excluded by default and always reads FINE, since its own roster entry
 * carries the definitive answer here rather than a per-role special-case.
 * Pure over already-fetched roster/supervisor data; performs no herdr I/O of
 * its own.
 */
export function classifyBlockedTransition(
  agent: string,
  roster: readonly AgentStatusesRosterEntry[],
  supervisors: ReadonlyMap<string, string>,
): BlockedTransitionVerdict {
  const role = roster.find((entry) => sameAgentName(entry.name, agent))?.role;
  if (role === undefined || !BLOCKED_PAGING_APPLICABLE_ROLES.has(role)) {
    return BLOCKED_TRANSITION_VERDICTS.FINE;
  }
  return hasLiveChildren(agent, roster, supervisors)
    ? BLOCKED_TRANSITION_VERDICTS.FINE
    : BLOCKED_TRANSITION_VERDICTS.STUCK;
}
