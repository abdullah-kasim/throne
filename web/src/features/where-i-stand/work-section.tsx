import type { PullRequestRecords } from "@contract/where-i-stand.ts";
import type { ReactNode } from "react";
import { describeAge } from "@/features/where-i-stand/describe-times";
import { InlineMarkdown } from "@/features/where-i-stand/markdown-text";
import type { PageEntry } from "@/features/where-i-stand/read-page";
import { ThroneAndDotfilesSpoiler } from "@/features/where-i-stand/throne-and-dotfiles-spoiler";
import { linkLine, numberedLabel, workRows, type LinkLine, type WorkRow } from "@/features/where-i-stand/work-rows";

const WORK_COLUMNS = ["Links", "What sort of work", "Where it stands"];
const WAITING_COLUMNS = ["Pull request", "Title", "Author", "Waiting on", "CI", "Age"];
const TEAMMATE_COLUMNS = ["Author", "Pull request", "Title", "State", "CI", "Last updated"];
const NO_WORK_WORDS = "No pull requests or agent entries to show.";

type OtherPullRequest = PullRequestRecords["waiting_for_review"][number] | PullRequestRecords["teammates"][number];

function LinkLineShown({ line }: { line: LinkLine }) {
  if (line.isMarkdown) {
    return (
      <div>
        <InlineMarkdown markdown={line.words} />
      </div>
    );
  }
  if (line.address !== null) {
    return (
      <div className="link-line">
        <a href={line.address} rel="noreferrer">
          {line.words}
        </a>
      </div>
    );
  }
  return <div className={line.isMissing ? "missing" : undefined}>{line.words}</div>;
}

function Table({ columns, rows, emptyWords }: { columns: readonly string[]; rows: readonly (readonly ReactNode[])[]; emptyWords: string }) {
  if (rows.length === 0) return <p>{emptyWords}</p>;
  return (
    <table>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column}>{column}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, rowIndex) => (
          <tr key={rowIndex}>
            {cells.map((cell, cellIndex) => (
              <td key={columns[cellIndex]} data-label={columns[cellIndex]}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function workCells(row: WorkRow): ReactNode[] {
  return [
    row.links.map((line, index) => <LinkLineShown key={index} line={line} />),
    <>
      <div className="kind">
        <LinkLineShown line={row.kind} />
      </div>
      {row.title.words && <LinkLineShown line={row.title} />}
    </>,
    row.whereItStands.map((line, index) => <LinkLineShown key={index} line={line} />),
  ];
}

function checksWords({ checks: { passing, failing, running } }: OtherPullRequest): string {
  const problems = [failing && `${failing} failing`, running && `${running} running`].filter(Boolean).join(", ");
  return problems || (passing ? "green" : "no CI");
}

function pullRequestLink(pullRequest: OtherPullRequest): ReactNode {
  const label = numberedLabel(pullRequest.repository.split("/").at(-1) ?? "", pullRequest.number);
  return <LinkLineShown line={linkLine(label, pullRequest.url, "")} />;
}

function teammateStateWords({ draft, review }: PullRequestRecords["teammates"][number]): string {
  return [draft ? "draft" : "ready", review.toLowerCase().replaceAll("_", " ")].filter(Boolean).join(", ");
}

function WaitingForReviewTable({ records, now }: { records: PullRequestRecords; now: number }) {
  const rows = records.waiting_for_review.map((pullRequest) => [
    pullRequestLink(pullRequest),
    pullRequest.title,
    pullRequest.author,
    pullRequest.waiting_on,
    checksWords(pullRequest),
    describeAge(pullRequest.created_at, now),
  ]);
  return <Table columns={WAITING_COLUMNS} rows={rows} emptyWords="No pull requests are waiting for your review." />;
}

function TeammatesTable({ records, now }: { records: PullRequestRecords; now: number }) {
  const rows = records.teammates.map((pullRequest) => [
    pullRequest.author,
    pullRequestLink(pullRequest),
    pullRequest.title,
    teammateStateWords(pullRequest),
    checksWords(pullRequest),
    describeAge(pullRequest.updated_at, now),
  ]);
  return <Table columns={TEAMMATE_COLUMNS} rows={rows} emptyWords="No open pull requests from your teammates." />;
}

function Problems({ problems }: { problems: readonly string[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="problem">
      {problems.map((problem) => (
        <li key={problem}>Could not read: {problem}</li>
      ))}
    </ul>
  );
}

function Changes({ changes }: { changes: readonly string[] }) {
  if (changes.length === 0) return null;
  return (
    <>
      <h3>Changed since the last refresh</h3>
      <ul>
        {changes.map((change) => (
          <li key={change}>
            <InlineMarkdown markdown={change} />
          </li>
        ))}
      </ul>
    </>
  );
}

interface WorkSectionProps {
  readonly records: PullRequestRecords | undefined;
  readonly recordsAreOnTheirWay: boolean;
  readonly entries: readonly PageEntry[];
  readonly recordsTime: string;
  readonly now: number;
}

export function WorkSection({ records, recordsAreOnTheirWay, entries, recordsTime, now }: WorkSectionProps) {
  const rows = recordsAreOnTheirWay ? [] : workRows(records, entries);
  const mainRows = rows.filter((row) => !row.throneOrDotfiles);
  const throneAndDotfilesRows = rows.filter((row) => row.throneOrDotfiles);
  return (
    <section className="work">
      <h2>Your work</h2>
      <p>{recordsTime}</p>
      <Problems problems={records?.problems ?? []} />
      <Changes changes={records?.changes ?? []} />
      {(records !== undefined || mainRows.length > 0) && <Table columns={WORK_COLUMNS} rows={mainRows.map(workCells)} emptyWords={NO_WORK_WORDS} />}
      <ThroneAndDotfilesSpoiler needsYouFlags={throneAndDotfilesRows.map((row) => row.needsYou)} everyRowIsKnown={records !== undefined}>
        <Table columns={WORK_COLUMNS} rows={throneAndDotfilesRows.map(workCells)} emptyWords={NO_WORK_WORDS} />
      </ThroneAndDotfilesSpoiler>
      {records !== undefined && (
        <>
          <h3>Waiting for your review</h3>
          <WaitingForReviewTable records={records} now={now} />
          <h3>Your teammates&apos; pull requests</h3>
          <TeammatesTable records={records} now={now} />
        </>
      )}
    </section>
  );
}
