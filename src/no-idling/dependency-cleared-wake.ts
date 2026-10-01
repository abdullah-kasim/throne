import type { LastMessageTagState } from './idle-pane-tag-classification.ts';
import type { NoIdlingDependencies } from './no-idling-dependencies.types.ts';
import { buildDependencyClearedMessage, buildStillBlockedOnClearedChildrenMessage } from './message.ts';
import {
  NO_IDLING_SENDER,
  NO_IDLING_SUBMIT_TIMEOUT_MS,
  regentAcceptsNotice,
  writeErr,
  writeOut,
} from './no-idling-notify-guard.ts';
import { NO_IDLING_REGENT_NAME } from './idle-family.ts';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Every currently-blocked agent's persisted `blockedBy` list, keyed by
 * agent name. An agent with no named children (or that is not blocked at
 * all) is absent -- this mechanism is entirely unaffected by either case,
 * matching the wake invariant's "no named children at all" carve-out.
 */
export function readBlockedAgentDependents(
  lastMessageTags: ReadonlyMap<string, LastMessageTagState>,
): ReadonlyMap<string, readonly string[]> {
  const dependents = new Map<string, readonly string[]>();
  for (const [name, tag] of lastMessageTags) {
    if (tag.kind === 'blocked' && tag.blockedBy.length > 0) {
      dependents.set(name, tag.blockedBy);
    }
  }
  return dependents;
}

export interface ClearedChildren {
  readonly gone: readonly string[];
  readonly reapable: readonly string[];
}

export function allClearedChildren(cleared: ClearedChildren): readonly string[] {
  return [...cleared.gone, ...cleared.reapable];
}

function hasPublishedReapableClaim(tag: LastMessageTagState | undefined): boolean {
  return tag?.kind === 'reapable' || tag?.kind === 'reapable-failed';
}

export async function resolveClearedDependencyWakes(
  blockedAgentDependents: ReadonlyMap<string, readonly string[]>,
  dataDir: string,
  isRegisteredAgent: (name: string, dataDir: string) => Promise<boolean>,
  lastMessageTags: ReadonlyMap<string, LastMessageTagState> = new Map(),
): Promise<ReadonlyMap<string, ClearedChildren>> {
  const cleared = new Map<string, ClearedChildren>();
  for (const [agentName, blockedBy] of blockedAgentDependents) {
    const gone: string[] = [];
    const reapable: string[] = [];
    for (const childName of blockedBy) {
      if (!(await isRegisteredAgent(childName, dataDir))) {
        gone.push(childName);
      } else if (hasPublishedReapableClaim(lastMessageTags.get(childName))) {
        reapable.push(childName);
      }
    }
    if (gone.length + reapable.length === blockedBy.length) {
      cleared.set(agentName, { gone, reapable });
    }
  }
  return cleared;
}

export const SWEEPS_BEFORE_TELLING_THE_REGENT = 2;
export const NO_IDLING_SWEEP_INTERVAL_MS = 60_000;
export const DELAY_BEFORE_TELLING_THE_REGENT_MS =
  SWEEPS_BEFORE_TELLING_THE_REGENT * NO_IDLING_SWEEP_INTERVAL_MS;

function stillBlockedObservationKey(agentName: string, cleared: ClearedChildren): string {
  return `${agentName}:${[...allClearedChildren(cleared)].sort().join(',')}`;
}

export function countStillBlockedSweeps(
  observations: Map<string, number>,
  clearedDependencyWakes: ReadonlyMap<string, ClearedChildren>,
): ReadonlyMap<string, number> {
  const current = new Set<string>();
  const counts = new Map<string, number>();
  for (const [agentName, cleared] of clearedDependencyWakes) {
    const key = stillBlockedObservationKey(agentName, cleared);
    current.add(key);
    const count = (observations.get(key) ?? 0) + 1;
    observations.set(key, count);
    counts.set(agentName, count);
  }
  for (const key of [...observations.keys()]) {
    if (!current.has(key)) observations.delete(key);
  }
  return counts;
}

export async function notifyRegentOfStillBlockedAgents(
  deps: NoIdlingDependencies,
  clearedDependencyWakes: ReadonlyMap<string, ClearedChildren>,
  sweepCounts: ReadonlyMap<string, number>,
): Promise<void> {
  const stuck = [...clearedDependencyWakes].filter(
    ([agentName]) => (sweepCounts.get(agentName) ?? 0) >= SWEEPS_BEFORE_TELLING_THE_REGENT,
  );
  if (stuck.length === 0) return;
  try {
    const regent = await deps.resolveAgent(NO_IDLING_REGENT_NAME);
    if (!regentAcceptsNotice(regent.agentStatus)) {
      writeOut(deps, `no-idling: Regent is ${regent.agentStatus}; deferred still-blocked notice\n`);
      return;
    }
    await deps.submitToAgent(
      regent,
      NO_IDLING_SENDER,
      buildStillBlockedOnClearedChildrenMessage({
        agents: stuck.map(([agentName, cleared]) => ({ agentName, ...cleared })),
      }),
      {
        key: `no-idling-still-blocked:${stuck
          .map(([agentName, cleared]) => stillBlockedObservationKey(agentName, cleared))
          .sort()
          .join(';')}`,
        composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS,
      },
    );
    writeOut(
      deps,
      `no-idling: told Regent that ${stuck.map(([agentName]) => agentName).join(', ')} stayed blocked on cleared children\n`,
    );
  } catch (error) {
    writeErr(deps, `no-idling: still-blocked notice failed: ${errText(error)}\n`);
  }
}

/**
 * Clears the blocked marker and wakes each agent directly -- never the
 * Regent -- with a message naming exactly which children cleared. Mirrors
 * the rest of this sweep's own error handling: a failed wake is logged and
 * left for the next sweep to retry, never a retry ladder. The marker is
 * cleared only after a successful send, so a failed submit does not silently
 * drop the agent's own durable block record.
 */
export async function notifyClearedDependencyWakes(
  deps: NoIdlingDependencies,
  clearedDependencyWakes: ReadonlyMap<string, ClearedChildren>,
): Promise<void> {
  for (const [agentName, cleared] of clearedDependencyWakes) {
    const resolvedChildren = allClearedChildren(cleared);
    try {
      const agent = await deps.resolveAgent(agentName);
      await deps.submitToAgent(
        agent,
        NO_IDLING_SENDER,
        buildDependencyClearedMessage({ goneChildren: cleared.gone, reapableChildren: cleared.reapable }),
        {
          key: `no-idling-dependency-cleared:${agentName}:${[...resolvedChildren].sort().join(',')}`,
          composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS,
        },
      );
      await deps.blockedMarkerLedger.clearBlockedMarker(agentName);
      writeOut(
        deps,
        `no-idling: woke ${agentName} directly -- dependency cleared: ${resolvedChildren.join(', ')}\n`,
      );
    } catch (error) {
      writeErr(deps, `no-idling: dependency-cleared wake failed for ${agentName}: ${errText(error)}\n`);
    }
  }
}
