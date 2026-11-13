import type { AgentStateDeclaration } from '../agentdata/agent-state.service.ts';
import type { ReapabilityClaimStatus } from '../no-idling/idle-pane-tag-classification.ts';

const OWN_BACKGROUND_RUN = 'own-background-run';
const BLOCKED_BY_MARKER = /(?<![A-Za-z0-9])(?:__)?BLOCKED_BY_([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?:__)?(?![A-Za-z0-9_])/g;
const OWN_BACKGROUND_RUN_DESCRIPTION = /BLOCKED_BY_own-background-run(?:__)?[ \t]*\(([^)\n]*)\)/;
const BLOCKED_MARKER_ANYWHERE = /(?<![\w"])\{\s*"blocked"\s*:\s*true\s*\}(?![\w"])/;
const REAPABLE_CLAIM_ANYWHERE =
  /(?<![\w"])\{\s*"reapable"\s*:\s*"(completed|abandoned|cancelled|task_restart_required|fail)"\s*\}(?![\w"])/i;
const REAPABLE_STATUSES: readonly ReapabilityClaimStatus[] = ['completed', 'abandoned', 'task_restart_required', 'fail'];
const RENAMED_REAPABLE_STATUSES: Readonly<Record<string, ReapabilityClaimStatus>> = { cancelled: 'abandoned' };

export type TurnEndMarker =
  | { readonly kind: 'blocked'; readonly blockedBy: readonly string[]; readonly ownRun: string | null }
  | { readonly kind: 'reapable'; readonly status: ReapabilityClaimStatus }
  | { readonly kind: 'unmarked' };

function standaloneSingleKeyObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 1) {
      return value as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readReapableStatus(text: string): ReapabilityClaimStatus | undefined {
  const standalone = standaloneSingleKeyObject(text);
  const status = typeof standalone?.reapable === 'string' ? standalone.reapable : REAPABLE_CLAIM_ANYWHERE.exec(text)?.[1];
  const lowered = status?.toLowerCase();
  if (lowered === undefined) return undefined;
  const current = RENAMED_REAPABLE_STATUSES[lowered] ?? lowered;
  return REAPABLE_STATUSES.find((known) => known === current);
}

export function classifyLastMessageTags(message: string): TurnEndMarker {
  const trimmed = message.trim();
  if (standaloneSingleKeyObject(trimmed)?.blocked === true || BLOCKED_MARKER_ANYWHERE.test(trimmed)) {
    const names = [...trimmed.matchAll(BLOCKED_BY_MARKER)].map((match) => match[1]!);
    const ownRun = names.includes(OWN_BACKGROUND_RUN)
      ? OWN_BACKGROUND_RUN_DESCRIPTION.exec(trimmed)?.[1]?.trim() ?? ''
      : null;
    return { kind: 'blocked', blockedBy: names.filter((name) => name !== OWN_BACKGROUND_RUN), ownRun };
  }
  const status = readReapableStatus(trimmed);
  return status === undefined ? { kind: 'unmarked' } : { kind: 'reapable', status };
}

export function stateFromTurnEndMessage(message: string): AgentStateDeclaration | null {
  const marker = classifyLastMessageTags(message);
  if (marker.kind === 'unmarked') return null;
  if (marker.kind === 'reapable') return { state: 'reapable', reapableReason: marker.status, declaredBy: 'agent' };
  if (marker.blockedBy.length === 0 && marker.ownRun !== null) {
    return { state: 'waiting-on-own-run', waitingOn: marker.ownRun === '' ? null : marker.ownRun, declaredBy: 'agent' };
  }
  return { state: 'blocked', blockedBy: marker.blockedBy, declaredBy: 'agent' };
}
