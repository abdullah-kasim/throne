import type { RegentQueueItemRow } from "../regent-queue/regent-queue.store.ts";
import type { BriefSection } from "./brief-command-runner.ts";

export const RELEASE_REPLY_WAIT_MINUTES = 30;

function waitsOnObjective(row: RegentQueueItemRow, objectiveCode: string): boolean {
  return row.deferral?.dependsOn.includes(objectiveCode) ?? false;
}

function describeWaitingRow(row: RegentQueueItemRow, objectiveCode: string): string[] {
  const code = row.objectiveCode ?? row.id;
  const otherDependencies = row.deferral!.dependsOn.filter((dependency) => dependency !== objectiveCode);
  const alsoWaitsOn = otherDependencies.length === 0 ? "" : ` (also waits on: ${otherDependencies.join(", ")})`;
  return [
    `- ${code}${alsoWaitsOn}`,
    `  \`throne send-agent Regent "Release deferred ${code}: ${objectiveCode} delivered at <sha>"\``,
  ];
}

export function readDeferredRowsWaitingOn(
  rows: readonly RegentQueueItemRow[],
  objectiveCode: string,
): BriefSection[] {
  const waiting = rows.filter((row) => waitsOnObjective(row, objectiveCode));
  if (waiting.length === 0) return [];
  return [
    {
      title: "Deferred rows waiting on this objective",
      trimmable: false,
      lines: [
        "These queue rows stay deferred until the Regent releases them. After your delivery is merged " +
          "(and its CI is green, for a pull request), send the Regent each request below with <sha> " +
          'replaced by the delivered commit, then wait for its "Released <code>" reply before you report done.',
        ...waiting.flatMap((row) => describeWaitingRow(row, objectiveCode)),
        "Wait with Monitor or a bounded loop, never a bare sleep. If a request has no reply after " +
          `${RELEASE_REPLY_WAIT_MINUTES} minutes, send it once more; if it is still unanswered, say so in your DONE report.`,
      ],
    },
  ];
}
