import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import type { LastMessageTagState } from './idle-pane-tag-classification.ts';
import {
  AGENT_MIN_AGE_MS,
  isReapabilityProtocolCandidate,
} from './idle-family.ts';
import { canEvaluateReapabilityClaim } from '../autoreap/supervising-wait.ts';

export type ReapabilityProtocolViolationReason =
  | 'idle-with-no-claim'
  | 'retired-marker-still-emitting'
  | 'claimed-but-refused';

export interface ReapabilityProtocolViolation {
  readonly agent: string;
  readonly reason: ReapabilityProtocolViolationReason;
}

/** Project applicable idle agents onto protocol violations using shared tags. */
export function findReapabilityProtocolViolations(
  roster: readonly AgentStatusesRosterEntry[],
  lastMessageTags: ReadonlyMap<string, LastMessageTagState>,
  idleByDesignChildren: ReadonlySet<string>,
  agentAgeMs?: ReadonlyMap<string, number>,
  claimedButRefused: ReadonlySet<string> = new Set(),
  supervisors: ReadonlyMap<string, string> = new Map(),
): ReapabilityProtocolViolation[] {
  const violations: ReapabilityProtocolViolation[] = [];
  for (const entry of roster) {
    if (
      !isReapabilityProtocolCandidate(entry) ||
      idleByDesignChildren.has(entry.name)
    ) {
      continue;
    }
    const ageMs = agentAgeMs?.get(entry.name);
    if (ageMs !== undefined && ageMs < AGENT_MIN_AGE_MS) {
      continue;
    }
    const kind = lastMessageTags.get(entry.name)?.kind;
    if (claimedButRefused.has(entry.name) && kind === 'reapable') {
      violations.push({ agent: entry.name, reason: 'claimed-but-refused' });
    } else if (
      kind === 'unmarked' &&
      canEvaluateReapabilityClaim(entry, roster, supervisors)
    ) {
      violations.push({ agent: entry.name, reason: 'idle-with-no-claim' });
    } else if (kind === 'retired-reapable-marker') {
      violations.push({ agent: entry.name, reason: 'retired-marker-still-emitting' });
    }
  }
  return violations.sort((left, right) => left.agent.localeCompare(right.agent));
}
