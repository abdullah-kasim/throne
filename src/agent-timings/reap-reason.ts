export const REAP_REASON = {
  COMPLETED: "completed",
  COMPLETED_UNPUBLISHABLE: "completed-unpublishable",
  STALLED: "stalled",
  FORCE: "force",
  ORPHAN: "orphan",
  SUPERSEDED: "superseded",
  ERROR: "error",
  CANCELLED: "cancelled",
  SCRATCH: "scratch",
  OTHER: "other",
} as const;

export const REAP_REASONS = Object.values(REAP_REASON);
export type ReapReason = (typeof REAP_REASONS)[number];

export function isReapReason(value: string): value is ReapReason {
  return REAP_REASONS.some((reason) => reason === value);
}
