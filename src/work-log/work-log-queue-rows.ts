import type { RegentQueueItemRow } from "../regent-queue/regent-queue-row.ts";
import { planSectionLines } from "../situation-brief/sibling-objectives.ts";
import { isInWindow, type WorkLogWindow } from "./work-log-window.ts";

const FIRST_SENTENCE_NOT_ENDING_AT_A_LIST_MARKER = /^.*?(?<!^\d+)[.!?](?=\s|$)/ms;

export function intentFirstSentence(body: string): string | null {
  const intent = planSectionLines(body, "INTENT:").join("\n");
  if (intent === "") return null;
  return (FIRST_SENTENCE_NOT_ENDING_AT_A_LIST_MARKER.exec(intent)?.[0] ?? intent).replaceAll("\n", " ");
}

export function queueRowsInWindow(
  rows: readonly RegentQueueItemRow[],
  window: WorkLogWindow,
): RegentQueueItemRow[] {
  return rows
    .filter((row) => isInWindow(row.completedAt, window) || isInWindow(row.updatedAt, window))
    .sort((left, right) => left.updatedAt - right.updatedAt);
}
