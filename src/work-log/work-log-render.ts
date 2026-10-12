import type { RegentQueueItemRow } from "../regent-queue/regent-queue-row.ts";
import { outcomeFieldsOf } from "../regent-queue/regent-queue-render.ts";
import type { GithubAction, GithubActionsInWindow } from "./work-log-github-actions.ts";
import { intentFirstSentence } from "./work-log-queue-rows.ts";

export interface WorkLog {
  readonly since: Date;
  readonly rows: readonly RegentQueueItemRow[];
  readonly githubActions: GithubActionsInWindow;
}

function isoTimeOrNull(timestamp: number | null | undefined): string | null {
  return timestamp == null ? null : new Date(timestamp).toISOString();
}

function rowLabel(row: RegentQueueItemRow): string {
  return row.objectiveCode ?? row.id;
}

function renderRow(row: RegentQueueItemRow): string {
  const fields = [...outcomeFieldsOf(row), `updated: ${isoTimeOrNull(row.updatedAt)}`];
  const intent = intentFirstSentence(row.body);
  const intentLine = intent === null ? "" : `\n  Intent: ${intent}`;
  return `- **${rowLabel(row)}** (${row.status}) _(${fields.join(", ")})_${intentLine}`;
}

function renderGithubAction(action: GithubAction): string {
  const repository = action.repo === null ? undefined : `on ${[action.host, action.repo].filter(Boolean).join("/")}`;
  return [
    `- ${action.timestamp}`,
    `\`${action.subcommand}\``,
    repository,
    action.pr === null ? undefined : `#${action.pr}`,
    action.agent === null ? undefined : `by ${action.agent}`,
    `exit ${action.exit_code}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

function renderSection(title: string, lines: readonly string[]): string {
  return `## ${title} (${lines.length})\n\n${lines.length === 0 ? "None." : lines.join("\n")}`;
}

function renderMalformedLineCount(count: number): string[] {
  return count === 0 ? [] : [`Skipped ${count} malformed GitHub action log line(s).`];
}

export function renderWorkLogText(log: WorkLog): string {
  return [
    `# Work log since ${log.since.toISOString()}`,
    renderSection("Queue rows", log.rows.map(renderRow)),
    renderSection("GitHub actions", log.githubActions.actions.map(renderGithubAction)),
    ...renderMalformedLineCount(log.githubActions.malformedLineCount),
  ].join("\n\n");
}

function rowAsJson(row: RegentQueueItemRow): Record<string, unknown> {
  return {
    objectiveCode: row.objectiveCode,
    status: row.status,
    outcome: row.outcome ?? null,
    outcomeSummary: row.outcomeSummary ?? null,
    prUrl: row.prUrl ?? null,
    resultCommit: row.resultCommit ?? null,
    completedAt: isoTimeOrNull(row.completedAt),
    updatedAt: isoTimeOrNull(row.updatedAt),
    intent: intentFirstSentence(row.body),
  };
}

export function renderWorkLogJson(log: WorkLog): string {
  return JSON.stringify(
    {
      since: log.since.toISOString(),
      rows: log.rows.map(rowAsJson),
      githubActions: log.githubActions.actions,
      malformedGithubActionLines: log.githubActions.malformedLineCount,
    },
    null,
    2,
  );
}
