import { readFile } from "node:fs/promises";
import { completionReportPathForAgent } from "../agentdata/ledger-data.service.ts";
import type { StatedQueueOutcome } from "../regent-queue/regent-queue-lifecycle.ts";
import { isQueueOutcome } from "../regent-queue/regent-queue-outcome.ts";

export const ReportOutcomeState = {
  Stated: "stated",
  NotStated: "not stated",
  Invalid: "invalid",
} as const;

export type ReportOutcomeReading =
  | {
      readonly state: typeof ReportOutcomeState.Stated;
      readonly statedOutcome: StatedQueueOutcome;
    }
  | { readonly state: typeof ReportOutcomeState.NotStated }
  | {
      readonly state: typeof ReportOutcomeState.Invalid;
      readonly statedValue: string;
    };

const OUTCOME_HEADING = "## Outcome";
const SECTION_END_HEADING = /^#{1,2} /;

const ReportOutcomeLabel = {
  Outcome: "Outcome",
  OutcomeSummary: "Outcome summary",
  PullRequest: "PR",
  ResultCommit: "Result commit",
} as const;

function outcomeSectionLines(report: string): string[] {
  const lines = report.split("\n").map((line) => line.trim());
  const headingIndex = lines.indexOf(OUTCOME_HEADING);
  if (headingIndex === -1) return [];
  const afterHeading = lines.slice(headingIndex + 1);
  const endIndex = afterHeading.findIndex((line) =>
    SECTION_END_HEADING.test(line),
  );
  return endIndex === -1 ? afterHeading : afterHeading.slice(0, endIndex);
}

function labelledValue(
  sectionLines: readonly string[],
  label: string,
): string | undefined {
  const prefix = `- **${label}:**`;
  const line = sectionLines.find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value === undefined || value === "" ? undefined : value;
}

export function parseReportOutcome(report: string): ReportOutcomeReading {
  const sectionLines = outcomeSectionLines(report);
  const statedValue = labelledValue(sectionLines, ReportOutcomeLabel.Outcome);
  if (statedValue === undefined) return { state: ReportOutcomeState.NotStated };
  if (!isQueueOutcome(statedValue)) {
    return { state: ReportOutcomeState.Invalid, statedValue };
  }
  return {
    state: ReportOutcomeState.Stated,
    statedOutcome: {
      outcome: statedValue,
      outcomeSummary: labelledValue(
        sectionLines,
        ReportOutcomeLabel.OutcomeSummary,
      ),
      prUrl: labelledValue(sectionLines, ReportOutcomeLabel.PullRequest),
      resultCommit: labelledValue(
        sectionLines,
        ReportOutcomeLabel.ResultCommit,
      ),
    },
  };
}

export async function readReportOutcome(
  agentName: string,
  ledgerBaseDir?: string,
): Promise<ReportOutcomeReading> {
  try {
    const report = await readFile(
      completionReportPathForAgent(agentName, ledgerBaseDir),
      "utf8",
    );
    return parseReportOutcome(report);
  } catch {
    return { state: ReportOutcomeState.NotStated };
  }
}
