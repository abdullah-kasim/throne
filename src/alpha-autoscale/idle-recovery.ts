import {
  openRegentQueueStore,
  type RegentQueueStore,
} from "../regent-queue/regent-queue.store.ts";
import { RegentQueueItemStatus } from "../regent-queue/regent-queue-item-state.ts";
import type { RegentQueueItemRow } from "../regent-queue/regent-queue-row.ts";

export interface IdleRecoveryOutcome {
  readonly recovered: string | null;
}

export interface IdleRecoveryDeps {
  readonly openStore?: () => RegentQueueStore;
  readonly log?: (message: string) => void;
}

export function isAgentlessInFlight(item: RegentQueueItemRow): boolean {
  return (
    item.status === RegentQueueItemStatus.InFlight && item.agentName === null
  );
}

function hasOpenRow(items: readonly RegentQueueItemRow[]): boolean {
  return items.some((item) => item.status === RegentQueueItemStatus.Open);
}

export function idleRecoveryCandidates(
  items: readonly RegentQueueItemRow[],
): RegentQueueItemRow[] {
  return items
    .filter((item) => item.objectiveCode !== null && isAgentlessInFlight(item))
    .sort((a, b) => b.priority - a.priority);
}

export function planIdleRecovery(
  items: readonly RegentQueueItemRow[],
): RegentQueueItemRow | undefined {
  return hasOpenRow(items) ? undefined : idleRecoveryCandidates(items)[0];
}

export function reopenRows(
  items: readonly RegentQueueItemRow[],
  objectiveCodes: ReadonlySet<string>,
): RegentQueueItemRow[] {
  return items.map((item) =>
    item.objectiveCode !== null && objectiveCodes.has(item.objectiveCode)
      ? { ...item, status: RegentQueueItemStatus.Open }
      : item,
  );
}

export function recoverIdleWork(
  deps: IdleRecoveryDeps = {},
): IdleRecoveryOutcome {
  const store = (deps.openStore ?? openRegentQueueStore)();
  try {
    const read = store.readAll();
    if (read.state !== "items") {
      return { recovered: null };
    }
    const target = planIdleRecovery(read.items);
    if (target === undefined) {
      return { recovered: null };
    }
    store.transitionStatus(target.id, RegentQueueItemStatus.Open);
    deps.log?.(
      `idle recovery: promoted in-flight objective "${target.objectiveCode}" to open — ` +
        `the ready queue was exhausted and this row had no agent flying it`,
    );
    return { recovered: target.objectiveCode };
  } finally {
    store.close();
  }
}

export function buildIdleRecoveryNotice(
  outcome: IdleRecoveryOutcome,
): string | undefined {
  if (outcome.recovered === null) return undefined;
  return (
    `IDLE RECOVERY: the ready queue was exhausted, so objective ` +
    `"${outcome.recovered}", in flight with no agent flying it, was promoted to ` +
    `open and will launch. If it should wait instead, hold it now with ` +
    `update-queue --objective-code ${outcome.recovered} --status deferred ` +
    `--depends-on <codes> --defer-reason "<text>"; a deferred row starts only ` +
    `when the Regent runs release-deferred.`
  );
}
