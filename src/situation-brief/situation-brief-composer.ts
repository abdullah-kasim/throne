import { RECONCILED_THROUGH_LABEL } from "../amendment/amendment-notices.ts";
import type { QueueAmendment } from "../regent-queue/regent-queue-amendments.ts";
import { renderQueueAmendment } from "../regent-queue/regent-queue-render.ts";
import type { BriefSection } from "./brief-command-runner.ts";

export const SITUATION_BRIEF_HEADING = "## Situation at launch";
export const INFORMATIONAL_SIZE_LIMIT_BYTES = 4096;

function renderAmendments(amendments: readonly QueueAmendment[]): string {
  if (amendments.length === 0) {
    return (
      "### Amendments recorded on this row\n\n" +
      "None yet. If one is recorded while you work you will be messaged, and delivery is refused " +
      `until your plan records it as reconciled with a "${RECONCILED_THROUGH_LABEL} <n>" line.`
    );
  }
  const highest = amendments.at(-1)!.number;
  return [
    "### Amendments recorded on this row",
    "",
    "These change the spec above and are part of it. Reconcile every one into your plan as a source turn, " +
      `then record "${RECONCILED_THROUGH_LABEL} ${highest}" in 00_overview.md (verify.md when sliceless). ` +
      "Delivery is refused until you do.",
    ...amendments.map((amendment) => `\n${renderQueueAmendment(amendment)}`),
  ].join("\n");
}

function renderSection(section: BriefSection): string {
  return `### ${section.title}\n\n${section.lines.join("\n")}`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function trimSectionsToLimit(
  sections: readonly BriefSection[],
  limitBytes: number,
): { readonly sections: BriefSection[]; readonly droppedLines: number } {
  const working = sections.map((section) => ({ ...section, lines: [...section.lines] }));
  let droppedLines = 0;
  const size = () => byteLength(working.map(renderSection).join("\n\n"));
  while (size() > limitBytes) {
    const victim = working.find((section) => section.trimmable && section.lines.length > 1);
    if (victim === undefined) break;
    victim.lines.pop();
    droppedLines += 1;
  }
  return { sections: working, droppedLines };
}

export function composeSituationBrief(input: {
  readonly objectiveCode: string;
  readonly composedAt: string;
  readonly amendments: readonly QueueAmendment[];
  readonly sections: readonly BriefSection[];
  readonly sizeLimitBytes?: number;
}): string {
  const trimmed = trimSectionsToLimit(
    input.sections,
    input.sizeLimitBytes ?? INFORMATIONAL_SIZE_LIMIT_BYTES,
  );
  const parts = [
    SITUATION_BRIEF_HEADING,
    `Composed ${input.composedAt} for queue row "${input.objectiveCode}". These are facts at launch; ` +
      "the queue body above, with the amendments below, remains the spec of record.",
    renderAmendments(input.amendments),
    ...trimmed.sections.map(renderSection),
  ];
  if (trimmed.droppedLines > 0) {
    parts.push(
      `(${trimmed.droppedLines} older line(s) were left out to keep this brief under ` +
        `${INFORMATIONAL_SIZE_LIMIT_BYTES / 1024} KB; run \`throne situation-brief --objective-code ${input.objectiveCode}\` for the rest.)`,
    );
  }
  return parts.join("\n\n");
}
