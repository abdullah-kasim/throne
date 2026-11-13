import type { StoredRow } from "../web-api-contract/where-i-stand.ts";

const FIELD_SEPARATOR = " · ";
const TICKET_FIELD_PREFIX = "Ticket ";
const NO_PULL_REQUEST = "no pull request";
const NO_TICKET = "no ticket";
const PULL_REQUEST_FIELD = /^(?:Forgejo|GitHub) (\S+)/;

interface EntryLinks {
  readonly pullRequestUrls: readonly string[];
  readonly ticket: string;
  readonly commitOrBranch: string | undefined;
}

function pullRequestUrlIn(field: string): string[] {
  const url = PULL_REQUEST_FIELD.exec(field)?.[1];
  return url !== undefined && URL.canParse(url) ? [url] : [];
}

function linksOf(row: StoredRow): EntryLinks {
  const fields = (row.links ?? "").split(FIELD_SEPARATOR).map((field) => field.trim());
  return {
    pullRequestUrls: fields.flatMap(pullRequestUrlIn),
    ticket: fields.find((field) => field.startsWith(TICKET_FIELD_PREFIX))?.slice(TICKET_FIELD_PREFIX.length).trim() ?? NO_TICKET,
    commitOrBranch: fields[0] === NO_PULL_REQUEST ? fields[1] : undefined,
  };
}

function pullRequestJoiner(rows: readonly StoredRow[]): (url: string) => string {
  const joinedTo = new Map<string, string>();
  const workOf = (url: string): string => {
    const joined = joinedTo.get(url);
    return joined === undefined ? url : workOf(joined);
  };
  for (const row of rows) {
    const [first, ...twins] = linksOf(row).pullRequestUrls;
    for (const twin of twins) {
      const twinWork = workOf(twin);
      if (first !== undefined && twinWork !== workOf(first)) joinedTo.set(twinWork, workOf(first));
    }
  }
  return workOf;
}

function sameWork(one: EntryLinks, other: EntryLinks, workOf: (url: string) => string): boolean {
  if (one.pullRequestUrls.length > 0 || other.pullRequestUrls.length > 0) {
    return one.pullRequestUrls.some((url) => other.pullRequestUrls.some((otherUrl) => workOf(url) === workOf(otherUrl)));
  }
  return one.ticket !== NO_TICKET && one.ticket === other.ticket && one.commitOrBranch !== undefined && one.commitOrBranch === other.commitOrBranch;
}

export function rowsAboutTheSameWork(row: StoredRow, rows: readonly StoredRow[]): StoredRow[] {
  const workOf = pullRequestJoiner(rows);
  const links = linksOf(row);
  return rows.filter((other) => other.id !== row.id && other.code !== row.code && sameWork(links, linksOf(other), workOf));
}

export function stillSays(row: StoredRow): string {
  return `${row.id} "${row.code}" still says "${row.whereItStands}"`;
}
