import type { QueueAmendment } from "../regent-queue/regent-queue-amendments.ts";

export const MAXIMUM_NOTICE_LENGTH = 400;

export const RECONCILED_THROUGH_LABEL = "**Queue amendments reconciled through:**";

export const READ_AMENDMENTS_COMMAND = "throne render-queue --status in-flight";

export function composeNoticeForAlpha(amendment: QueueAmendment): string {
  return (
    `AMENDMENT ${amendment.number} on your queue row "${amendment.objectiveCode}" ` +
    `(words of ${amendment.wordsOf}). Read it whole with \`${READ_AMENDMENTS_COMMAND}\`, ` +
    `reconcile it into your plan, and record "${RECONCILED_THROUGH_LABEL} ${amendment.number}" ` +
    `before your next dispatch or delivery.`
  );
}

export function composeNoticeForRegent(
  amendment: QueueAmendment,
  alphaName: string | null,
): string {
  const told =
    alphaName === null
      ? "NO Alpha is recorded on this in-flight row, so no one else was told"
      : `${alphaName} has been told`;
  return (
    `AMENDMENT ${amendment.number} recorded on "${amendment.objectiveCode}" ` +
    `(words of ${amendment.wordsOf}, relayed by ${amendment.relayedBy}); ${told}. ` +
    `Read it with \`${READ_AMENDMENTS_COMMAND}\`.`
  );
}
