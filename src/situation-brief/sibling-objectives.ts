import { LIVE_QUEUE_ITEM_STATUSES } from "../regent-queue/regent-queue-render.ts";
import type { RegentQueueItemRow } from "../regent-queue/regent-queue.store.ts";
import type { BriefSection } from "./brief-command-runner.ts";

export const RECENTLY_FINISHED_WINDOW_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const RULING_LINES_PER_SIBLING = 5;
const RULING_LINE_LENGTH = 200;
const PLAN_MARKERS = ["INTENT:", "SCOPE:", "RULINGS:", "VERIFIED-NOUNS:", "REUSE:"];

export function deliveryBranchOf(row: RegentQueueItemRow): string | null {
  return row.prBranch ?? row.launchEligibility?.targetBranch ?? null;
}

export function repositoryOf(row: RegentQueueItemRow): string | null {
  return row.launchEligibility?.targetRepo ?? row.targetRepo;
}

function isRelevantSibling(
  row: RegentQueueItemRow,
  self: RegentQueueItemRow,
  now: number,
): boolean {
  if (row.id === self.id) return false;
  const sameRepository = repositoryOf(row) !== null && repositoryOf(row) === repositoryOf(self);
  const sameBranch = deliveryBranchOf(row) !== null && deliveryBranchOf(row) === deliveryBranchOf(self);
  if (!sameRepository && !sameBranch) return false;
  return (
    LIVE_QUEUE_ITEM_STATUSES.includes(row.status) ||
    now - row.updatedAt <= RECENTLY_FINISHED_WINDOW_MILLISECONDS
  );
}

export function rulingLinesOf(body: string): string[] {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trimStart().startsWith("RULINGS:"));
  if (start === -1) return [];
  const rulings: string[] = [];
  const first = lines[start]!.trimStart().slice("RULINGS:".length).trim();
  if (first !== "") rulings.push(first);
  for (const line of lines.slice(start + 1)) {
    if (PLAN_MARKERS.some((marker) => line.trimStart().startsWith(marker))) break;
    if (line.trim() !== "") rulings.push(line.trim());
  }
  return rulings
    .slice(0, RULING_LINES_PER_SIBLING)
    .map((line) => (line.length > RULING_LINE_LENGTH ? `${line.slice(0, RULING_LINE_LENGTH)}…` : line));
}

function describeSibling(row: RegentQueueItemRow): string[] {
  const facts = [
    row.status,
    deliveryBranchOf(row) === null ? undefined : `branch ${deliveryBranchOf(row)}`,
    row.agentName === null ? undefined : `agent ${row.agentName}`,
    row.deliveryCommit === null ? undefined : `delivered ${row.deliveryCommit}`,
  ].filter((fact): fact is string => fact !== undefined);
  const rulings = rulingLinesOf(row.body).map((ruling) => `  > ${ruling}`);
  return [`- ${row.objectiveCode ?? row.id} (${facts.join(", ")})`, ...rulings];
}

export function readSiblingObjectives(
  rows: readonly RegentQueueItemRow[],
  self: RegentQueueItemRow,
  now: number,
): BriefSection {
  const siblings = rows
    .filter((row) => isRelevantSibling(row, self, now))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return {
    title: "Other queue work on the same repository or branch",
    trimmable: true,
    lines:
      siblings.length === 0
        ? ["None in the queue, live or finished in the last 7 days."]
        : siblings.flatMap(describeSibling),
  };
}
