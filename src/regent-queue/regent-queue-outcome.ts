import {
  type RegentQueueItemStatus,
  TERMINAL_QUEUE_ITEM_STATUSES,
} from "./regent-queue-item-state.ts";

export const QueueOutcome = {
  Delivered: "delivered",
  Merged: "merged",
  Refused: "refused",
  Blocked: "blocked",
  Abandoned: "abandoned",
} as const;

export type QueueOutcome = (typeof QueueOutcome)[keyof typeof QueueOutcome];

export const OUTCOME_NOT_RECORDED = "not recorded";

const QUEUE_OUTCOMES: readonly string[] = Object.values(QueueOutcome);

export function isQueueOutcome(value: string): value is QueueOutcome {
  return QUEUE_OUTCOMES.includes(value);
}

export function requireQueueOutcome(value: string): QueueOutcome {
  if (!isQueueOutcome(value)) {
    throw new Error(
      `queue outcome "${value}" is invalid — expected one of ${QUEUE_OUTCOMES.join(", ")}`,
    );
  }
  return value;
}

export interface QueueOutcomeMutation {
  readonly outcome?: QueueOutcome | null;
  readonly outcomeSummary?: string | null;
  readonly prUrl?: string | null;
  readonly resultCommit?: string | null;
}

export interface QueueOutcomeRecord {
  readonly outcome?: QueueOutcome | null;
  readonly outcomeSummary?: string | null;
  readonly prUrl?: string | null;
  readonly resultCommit?: string | null;
  readonly completedAt?: number | null;
}

function completedAtAfter(
  current: QueueOutcomeRecord,
  nextStatus: RegentQueueItemStatus,
  timestamp: number,
): number | null {
  if (!TERMINAL_QUEUE_ITEM_STATUSES.has(nextStatus)) return null;
  return current.completedAt ?? timestamp;
}

export function outcomeColumnsAfterMutation(
  current: QueueOutcomeRecord,
  mutation: QueueOutcomeMutation,
  nextStatus: RegentQueueItemStatus,
  timestamp: number,
): [string | null, string | null, string | null, string | null, number | null] {
  const outcome =
    mutation.outcome === undefined ? current.outcome ?? null : mutation.outcome;
  return [
    outcome === null ? null : requireQueueOutcome(outcome),
    mutation.outcomeSummary === undefined
      ? current.outcomeSummary ?? null
      : mutation.outcomeSummary,
    mutation.prUrl === undefined ? current.prUrl ?? null : mutation.prUrl,
    mutation.resultCommit === undefined
      ? current.resultCommit ?? null
      : mutation.resultCommit,
    completedAtAfter(current, nextStatus, timestamp),
  ];
}
