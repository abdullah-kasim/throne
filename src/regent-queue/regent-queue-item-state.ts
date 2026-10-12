/**
 * Every Regent queue item moves forward through this state machine and only
 * this state machine: `open -> in-flight -> {complete | abandoned}`, plus
 * one edge back to `open` so an in-flight item whose launch never produced
 * an agent is available for a future attempt rather than stuck mid-flight
 * forever. `complete` and `abandoned` are terminal — the state machine never
 * reopens them; only an explicit `update-queue --status open` does.
 *
 * Pure state-transition types and a validator with no DB dependency, so a
 * caller (migration import, `add-to-queue`, `create-agent`'s write-back,
 * `reap-agent`'s write-back) can validate a transition without touching the
 * store — mirrors `message-queue-work-item-state.ts`'s shape for a
 * different entity.
 */
export const RegentQueueItemStatus = {
  Open: "open",
  Deferred: "deferred",
  InFlight: "in-flight",
  Complete: "complete",
  Abandoned: "abandoned",
} as const;

export type RegentQueueItemStatus =
  (typeof RegentQueueItemStatus)[keyof typeof RegentQueueItemStatus];

const ALLOWED_FORWARD_TRANSITIONS: ReadonlyMap<
  RegentQueueItemStatus,
  ReadonlySet<RegentQueueItemStatus>
> = new Map([
  [
    RegentQueueItemStatus.Open,
    new Set([RegentQueueItemStatus.InFlight, RegentQueueItemStatus.Deferred]),
  ],
  [
    RegentQueueItemStatus.Deferred,
    new Set([RegentQueueItemStatus.Open, RegentQueueItemStatus.Abandoned]),
  ],
  [
    RegentQueueItemStatus.InFlight,
    new Set([
      RegentQueueItemStatus.Complete,
      RegentQueueItemStatus.Abandoned,
      RegentQueueItemStatus.Open,
      RegentQueueItemStatus.Deferred,
    ]),
  ],
  [RegentQueueItemStatus.Complete, new Set()],
  [RegentQueueItemStatus.Abandoned, new Set()],
]);

export function isForwardQueueItemStatusTransition(
  from: RegentQueueItemStatus,
  to: RegentQueueItemStatus,
): boolean {
  return ALLOWED_FORWARD_TRANSITIONS.get(from)?.has(to) ?? false;
}

export const TERMINAL_QUEUE_ITEM_STATUSES: ReadonlySet<RegentQueueItemStatus> = new Set([
  RegentQueueItemStatus.Complete,
  RegentQueueItemStatus.Abandoned,
]);

export class InvalidQueueItemStatusTransitionError extends Error {
  readonly name = "InvalidQueueItemStatusTransitionError";
  readonly id: string;
  readonly from: RegentQueueItemStatus;
  readonly to: RegentQueueItemStatus;
  constructor(id: string, from: RegentQueueItemStatus, to: RegentQueueItemStatus) {
    super(
      `queue item "${id}" cannot transition ${from} -> ${to}: the state machine ` +
        `only moves forward through open -> in-flight -> {complete | abandoned}, ` +
        `with in-flight -> open allowed for an in-flight item whose launch never produced an agent`,
    );
    this.id = id;
    this.from = from;
    this.to = to;
  }
}

export class QueueItemNotFoundError extends Error {
  readonly name = "QueueItemNotFoundError";
  readonly id: string;
  constructor(id: string) {
    super(`queue item "${id}" does not exist`);
    this.id = id;
  }
}
