/**
 * Every work item moves forward through this state machine and only this
 * state machine: `queued -> {in-flight | cancelled}` and
 * `in-flight -> {delivered | failed}`. Terminal rows are never reopened.
 *
 * Pure state-transition types and validators with no DB dependency, so a
 * caller can validate a transition (or classify a state as terminal) without
 * touching the store at all. `message-queue.store.ts` composes these onto
 * its `DatabaseSync` handle rather than re-deriving the transition rules.
 */
export const MessageQueueWorkItemState = {
  Queued: "queued",
  InFlight: "in-flight",
  Cancelled: "cancelled",
  Delivered: "delivered",
  Failed: "failed",
} as const;

export type MessageQueueWorkItemState =
  (typeof MessageQueueWorkItemState)[keyof typeof MessageQueueWorkItemState];

const ALLOWED_FORWARD_TRANSITIONS: ReadonlyMap<
  MessageQueueWorkItemState,
  ReadonlySet<MessageQueueWorkItemState>
> = new Map([
  [
    MessageQueueWorkItemState.Queued,
    new Set([MessageQueueWorkItemState.InFlight, MessageQueueWorkItemState.Cancelled]),
  ],
  [
    MessageQueueWorkItemState.InFlight,
    new Set([
      MessageQueueWorkItemState.Delivered,
      MessageQueueWorkItemState.Failed,
    ]),
  ],
  [MessageQueueWorkItemState.Delivered, new Set()],
  [MessageQueueWorkItemState.Failed, new Set()],
  [MessageQueueWorkItemState.Cancelled, new Set()],
]);

export function isForwardWorkItemStateTransition(
  from: MessageQueueWorkItemState,
  to: MessageQueueWorkItemState,
): boolean {
  return ALLOWED_FORWARD_TRANSITIONS.get(from)?.has(to) ?? false;
}

export const TERMINAL_WORK_ITEM_STATES: ReadonlySet<MessageQueueWorkItemState> = new Set([
  MessageQueueWorkItemState.Delivered,
  MessageQueueWorkItemState.Failed,
  MessageQueueWorkItemState.Cancelled,
]);

export class InvalidWorkItemStateTransitionError extends Error {
  readonly name = "InvalidWorkItemStateTransitionError";
  readonly id: number;
  readonly from: MessageQueueWorkItemState;
  readonly to: MessageQueueWorkItemState;
  constructor(
    id: number,
    from: MessageQueueWorkItemState,
    to: MessageQueueWorkItemState,
  ) {
    super(
      `work item ${id} cannot transition ${from} -> ${to}: the state machine ` +
        `only moves forward through queued -> in-flight -> {delivered | failed}`,
    );
    this.id = id;
    this.from = from;
    this.to = to;
  }
}

export class WorkItemNotFoundError extends Error {
  readonly name = "WorkItemNotFoundError";
  readonly id: number;
  constructor(id: number) {
    super(`work item ${id} does not exist`);
    this.id = id;
  }
}
