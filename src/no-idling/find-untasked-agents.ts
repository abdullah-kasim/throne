import { agentStatusAcceptsInput } from '../herdr/herdr-inventory.service.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { AGENT_MIN_AGE_MS, spawnedAtAgeMs } from './idle-family.ts';
import type { SpawnSpec } from '../agentdata/spawn-data-contracts.ts';

/**
 * Closes the gap `findFullyIdleFamilies` cannot: that check only fires once
 * an Alpha's ENTIRE family — the Alpha and every one of its live children —
 * is simultaneously idle, so a single forgotten Shadow sitting untasked
 * among busy siblings is invisible to it for as long as the Alpha keeps
 * working (shadow-tbk-09, 2026-08-11: a busy Alpha juggling four in-flight
 * Shadows spawned a fifth and its `send-agent` assignment call never landed;
 * the Shadow was only caught ~30 minutes later, by accident, once the whole
 * family happened to go idle together). This check is per-agent: it flags
 * an untasked Alpha or Shadow on its own merits, independent of any
 * sibling's state.
 */
export interface UntaskedAgent {
  readonly name: string;
  readonly role: string;
  readonly ageMs: number;
}

export interface FindUntaskedAgentsEvidence {
  readonly roster: readonly AgentStatusesRosterEntry[];
  readonly readSpawnSpec: (name: string) => Promise<SpawnSpec | null>;
  /** A future scheduled assignment suppresses paging without changing tasked_at. */
  readonly hasFutureScheduledDelivery?: (name: string, nowMs: number) => Promise<boolean>;
  readonly now?: () => number;
}

const TASKED_ROLES = new Set(['Alpha', 'Shadow']);

function isIdleAcceptingInput(entry: AgentStatusesRosterEntry): boolean {
  return (
    entry.lifecycle === 'live' &&
    entry.liveStatus !== undefined &&
    agentStatusAcceptsInput(entry.liveStatus)
  );
}

/**
 * Every live Alpha/Shadow whose `spawn.json` explicitly records
 * `tasked_at: null` (registered under this scheme, never yet tasked),
 * that has cleared the same boot-time age floor `no-idling` uses, and is
 * currently idle-accepting-input — i.e. genuinely sitting untasked, not
 * still booting and not busy with a task that already landed. A record
 * that omits `tasked_at` entirely (spawned before this field existed, or a
 * role this scheme does not track) is never flagged: absence is "unknown,"
 * never "untasked."
 */
export async function findUntaskedAgents(
  evidence: FindUntaskedAgentsEvidence,
): Promise<UntaskedAgent[]> {
  const nowMs = (evidence.now ?? Date.now)();
  const untasked: UntaskedAgent[] = [];
  for (const entry of evidence.roster) {
    if (
      entry.role === undefined ||
      !TASKED_ROLES.has(entry.role) ||
      !isIdleAcceptingInput(entry)
    ) {
      continue;
    }
    const spec = await evidence.readSpawnSpec(entry.name);
    if (spec === undefined || spec === null || spec.tasked_at !== null) {
      continue;
    }
    const ageMs = spawnedAtAgeMs(spec.spawned_at, nowMs);
    if (ageMs === undefined || ageMs < AGENT_MIN_AGE_MS) {
      continue;
    }
    if (await evidence.hasFutureScheduledDelivery?.(entry.name, nowMs)) {
      continue;
    }
    untasked.push({ name: entry.name, role: entry.role, ageMs });
  }
  return untasked.sort((left, right) => left.name.localeCompare(right.name));
}
