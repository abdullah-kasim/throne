import type { LastMessageTagState } from './idle-pane-tag-classification.ts';
import type { NoIdlingDependencies } from './no-idling-dependencies.types.ts';
import { buildDependencyClearedMessage } from './message.ts';
import { NO_IDLING_SENDER, NO_IDLING_SUBMIT_TIMEOUT_MS, writeErr, writeOut } from './no-idling-notify-guard.ts';

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

/**
 * The blocked agents whose EVERY named child no longer has a live ledger
 * registration -- the wake invariant that must never mis-fire: an agent
 * naming two children where only one has cleared is left out entirely, not
 * partially reported. Liveness is decided exclusively by `isRegisteredAgent`
 * (ledger truth), never the roster, which is proven to lag teardown.
 */
export async function resolveClearedDependencyWakes(
  blockedAgentDependents: ReadonlyMap<string, readonly string[]>,
  dataDir: string,
  isRegisteredAgent: (name: string, dataDir: string) => Promise<boolean>,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const cleared = new Map<string, readonly string[]>();
  for (const [agentName, blockedBy] of blockedAgentDependents) {
    const stillRegistered = await Promise.all(
      blockedBy.map((childName) => isRegisteredAgent(childName, dataDir)),
    );
    if (stillRegistered.every((isRegistered) => !isRegistered)) {
      cleared.set(agentName, blockedBy);
    }
  }
  return cleared;
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
  clearedDependencyWakes: ReadonlyMap<string, readonly string[]>,
): Promise<void> {
  for (const [agentName, resolvedChildren] of clearedDependencyWakes) {
    try {
      const agent = await deps.resolveAgent(agentName);
      await deps.submitToAgent(
        agent,
        NO_IDLING_SENDER,
        buildDependencyClearedMessage({ resolvedChildren }),
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
