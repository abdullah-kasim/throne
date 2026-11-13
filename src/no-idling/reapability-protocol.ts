import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import type { LastMessageTagState } from './idle-pane-tag-classification.ts';
import { isReapabilityProtocolCandidate } from './idle-family.ts';
import { canEvaluateReapabilityClaim } from './supervising-wait.ts';
import type { SupervisorWait } from '../supervisor-wait/read-supervisor-wait.ts';
import { isWaitingBeforeItMayClaim } from './claim-wait.ts';

export type ReapabilityProtocolViolationReason =
  | 'idle-with-no-claim'
  | 'retired-marker-still-emitting';

export interface ReapabilityProtocolViolation {
  readonly agent: string;
  readonly reason: ReapabilityProtocolViolationReason;
  readonly backgroundWork?: string;
}

export function findReapabilityProtocolViolations(
  roster: readonly AgentStatusesRosterEntry[],
  lastMessageTags: ReadonlyMap<string, LastMessageTagState>,
  idleByDesignChildren: ReadonlySet<string>,
  withinSpawnGrace: ReadonlySet<string> = new Set(),
  supervisors: ReadonlyMap<string, string> = new Map(),
  supervisorWaits: ReadonlyMap<string, SupervisorWait> = new Map(),
  nowMs: number = Date.now(),
): ReapabilityProtocolViolation[] {
  const violations: ReapabilityProtocolViolation[] = [];
  for (const entry of roster) {
    if (
      !isReapabilityProtocolCandidate(entry) ||
      idleByDesignChildren.has(entry.name) ||
      withinSpawnGrace.has(entry.name)
    ) {
      continue;
    }
    const kind = lastMessageTags.get(entry.name)?.kind;
    if (
      kind === 'unmarked' &&
      !isWaitingBeforeItMayClaim(supervisorWaits.get(entry.name), nowMs) &&
      canEvaluateReapabilityClaim(entry, roster, supervisors)
    ) {
      violations.push({ agent: entry.name, reason: 'idle-with-no-claim' });
    } else if (kind === 'retired-reapable-marker') {
      violations.push({ agent: entry.name, reason: 'retired-marker-still-emitting' });
    }
  }
  return violations.sort((left, right) => left.agent.localeCompare(right.agent));
}
