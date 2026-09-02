/**
 * Every Regent queue item moves forward through this state machine and only
 * this state machine: `open -> in-flight -> {complete | abandoned}`, plus
 * one cancellation edge back to `open` so a queue item a launch didn't
 * finish is available for a future attempt rather than stuck mid-flight
 * forever. `complete` and `abandoned` are terminal — neither is ever
 * reopened.
 *
 * Pure state-transition types and a validator with no DB dependency, so a
 * caller (migration import, `add-to-queue`, `create-agent`'s write-back,
 * `reap-agent`'s write-back) can validate a transition without touching the
 * store — mirrors `message-queue-work-item-state.ts`'s shape for a
 * different entity.
 */
export const RegentQueueItemStatus = {
  Open: "open",
  /**
   * Filed, authorised, and deliberately NOT launchable yet.
   *
   * Added on the Lord's order, 2026-08-25. Before it existed, a hold had to be
   * spelled `in-flight` with no agent attached, because `open` means "the
   * autoscaler may launch this" and nothing else meant "not yet". That
   * conflation cost real throughput on the night it was fixed: five objectives
   * sat in-flight with no agent flying any of them, the court ran idle, and
   * `gbpg`'s hold — "wait until the other gabledge rows finish" — stayed shut
   * for hours after its condition had been satisfied, because nothing was
   * watching for it to clear.
   *
   * A deferred row carries WHY it is held: `deferred_depends_on` names the
   * objective codes that must reach a terminal status first, and the
   * autoscaler releases it automatically once they have.
   * `deferred_release_authority` marks the holds no predicate can evaluate —
   * "the Lord must rule on D6" — which only a named authority may lift.
   */
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
    // A deferred row goes back to `open` when its hold clears, or is
    // abandoned outright. It never jumps straight to in-flight: launching is
    // the autoscaler's move and it only ever reads `open`, so releasing to
    // `open` keeps one path into flight instead of two.
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
        `with in-flight -> open allowed on cancellation`,
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
