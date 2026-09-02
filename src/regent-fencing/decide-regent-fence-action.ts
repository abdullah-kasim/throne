import type { RegentQueueReadResult } from "../regent-queue/regent-queue.store.ts";
import { RegentQueueItemStatus } from "../regent-queue/regent-queue-item-state.ts";
import type { LaunchLedgerResult, LaunchRecord } from "../alpha-launch-queue/launch-ledger-reader.ts";

/**
 * "No launch for this long" is read as wedged, not merely quiet. Long
 * enough that a Regent legitimately between dispatches is never mistaken
 * for wedged; this is the threshold the Lord's order named directly.
 */
export const REGENT_FENCE_STALENESS_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Minimum time between one fence firing and the next being permitted. Long
 * enough that a freshly-summoned Regent has a full nudge cycle to resume
 * dispatching before it is judged wedged again; short enough that a Regent
 * still genuinely wedged after that cycle gets re-fenced within the same
 * working session rather than languishing until someone notices by hand.
 */
export const REGENT_FENCE_GRACE_PERIOD_MS = 15 * 60 * 1000;

export interface RegentFenceReason {
  readonly openCount: number;
  readonly minutesIdle: number;
  readonly now: number;
}

export type RegentFenceAction =
  | { readonly action: "fence"; readonly reason: RegentFenceReason }
  | { readonly action: "no-op"; readonly reason: string };

export interface DecideRegentFenceActionInput {
  readonly killSwitchOn: boolean;
  readonly queueState: RegentQueueReadResult;
  readonly launchLedgerState: LaunchLedgerResult;
  readonly now: number;
  readonly lastFenceAt: number | undefined;
  readonly gracePeriodMs: number;
}

function countOpenQueueItems(queueState: RegentQueueReadResult): number {
  if (queueState.state !== "items") return 0;
  return queueState.items.filter((item) => item.status === RegentQueueItemStatus.Open).length;
}

/**
 * Newest recorded spawn time across every launch-ledger entry, or
 * `undefined` when no launch has ever been recorded -- distinct from a
 * launch recorded so long ago it reads as stale, and the caller treats
 * "never launched" as maximally stale rather than as unknown.
 */
function findMostRecentSpawnedAtMs(entries: readonly LaunchRecord[]): number | undefined {
  let mostRecent: number | undefined;
  for (const entry of entries) {
    const spawnedAtMs = Date.parse(entry.spawnedAt);
    if (mostRecent === undefined || spawnedAtMs > mostRecent) {
      mostRecent = spawnedAtMs;
    }
  }
  return mostRecent;
}

/**
 * The one place the Regent-fencing decision is made. Mirrors
 * `decideAutoscaleAction`'s shape
 * (`src/alpha-autoscale/decide-autoscale-action.ts`): every refusal signal
 * below is independent and fails closed on its own -- none can be
 * overridden by any other signal being favorable, and the checks below can
 * run in any order because each one alone is sufficient to no-op:
 *
 * - kill switch OFF
 * - Regent queue `unknown` (distinct refusal reason from positively-empty --
 *   an unreadable queue never fires the clock)
 * - Regent queue `positively-empty` (nothing dispatchable is a normal,
 *   named no-op, not treated as an error)
 * - Regent queue `items` with zero rows in `RegentQueueItemStatus.Open`
 * - launch ledger `unknown` (an unreadable ledger is never read as "nothing
 *   launched recently, fence")
 * - launch ledger not stale enough (`now - mostRecentSpawnedAt` under
 *   `REGENT_FENCE_STALENESS_THRESHOLD_MS`; an empty entries array counts as
 *   maximally stale, never as unknown)
 * - inside the grace period since the last fence-ledger entry
 */
export function decideRegentFenceAction(
  input: DecideRegentFenceActionInput,
): RegentFenceAction {
  if (!input.killSwitchOn) {
    return { action: "no-op", reason: "kill switch off" };
  }
  if (input.queueState.state === "unknown") {
    return { action: "no-op", reason: `regent queue unknown: ${input.queueState.reason}` };
  }
  if (input.queueState.state === "positively-empty") {
    return { action: "no-op", reason: "regent queue positively empty" };
  }

  const openCount = countOpenQueueItems(input.queueState);
  if (openCount === 0) {
    return { action: "no-op", reason: "no open queue items" };
  }

  if (input.launchLedgerState.state === "unknown") {
    return {
      action: "no-op",
      reason: `launch ledger unknown: ${input.launchLedgerState.reason}`,
    };
  }

  const mostRecentSpawnedAtMs = findMostRecentSpawnedAtMs(input.launchLedgerState.entries);
  const minutesIdle =
    mostRecentSpawnedAtMs === undefined
      ? Infinity
      : (input.now - mostRecentSpawnedAtMs) / 60_000;
  const staleEnough =
    mostRecentSpawnedAtMs === undefined ||
    input.now - mostRecentSpawnedAtMs >= REGENT_FENCE_STALENESS_THRESHOLD_MS;
  if (!staleEnough) {
    return {
      action: "no-op",
      reason: `launch ledger not stale enough: ${minutesIdle.toFixed(1)} minutes idle`,
    };
  }

  if (
    input.lastFenceAt !== undefined &&
    input.now - input.lastFenceAt < input.gracePeriodMs
  ) {
    return { action: "no-op", reason: "inside grace period since last fence" };
  }

  return { action: "fence", reason: { openCount, minutesIdle, now: input.now } };
}
