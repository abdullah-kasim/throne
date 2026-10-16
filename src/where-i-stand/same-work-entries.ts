import type { PageEntry } from "./page-frame.ts";

const LINKS_LINE_PREFIX = "- Links: ";
const FIELD_SEPARATOR = " · ";
const TICKET_FIELD_PREFIX = "Ticket ";
const NO_PULL_REQUEST = "no pull request";
const NO_TICKET = "no ticket";
const PULL_REQUEST_FIELD = /^(?:Forgejo|GitHub) (\S+)/;
const SUPERSEDED_LINE = /^(?:- )?Superseded by `### /;
const WHERE_IT_STANDS_PREFIX = "- Where it stands:";

export interface EntryLinks {
  readonly line: string;
  readonly pullRequestUrls: readonly string[];
  readonly ticket: string;
  readonly commitOrBranch: string | undefined;
}

function linesOf(entry: PageEntry): string[] {
  return entry.body.split("\n").map((line) => line.trim());
}

function pullRequestUrlIn(field: string): string[] {
  const url = PULL_REQUEST_FIELD.exec(field)?.[1];
  return url !== undefined && URL.canParse(url) ? [url] : [];
}

export function readLinksLine(entry: PageEntry): EntryLinks | undefined {
  const line = entry.body.split("\n").find((bodyLine) => bodyLine.trim() !== "");
  if (line?.startsWith(LINKS_LINE_PREFIX) !== true) return undefined;
  const fields = line.slice(LINKS_LINE_PREFIX.length).split(FIELD_SEPARATOR).map((field) => field.trim());
  return {
    line: line.trim(),
    pullRequestUrls: fields.flatMap(pullRequestUrlIn),
    ticket: fields.find((field) => field.startsWith(TICKET_FIELD_PREFIX))?.slice(TICKET_FIELD_PREFIX.length).trim() ?? NO_TICKET,
    commitOrBranch: fields[0] === NO_PULL_REQUEST ? fields[1] : undefined,
  };
}

function pullRequestJoiner(page: readonly PageEntry[]): (url: string) => string {
  const joinedTo = new Map<string, string>();
  const workOf = (url: string): string => {
    const joined = joinedTo.get(url);
    return joined === undefined ? url : workOf(joined);
  };
  for (const entry of page) {
    const [first, ...twins] = readLinksLine(entry)?.pullRequestUrls ?? [];
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
  return (
    one.ticket !== NO_TICKET &&
    one.ticket === other.ticket &&
    one.commitOrBranch !== undefined &&
    one.commitOrBranch === other.commitOrBranch
  );
}

export function entriesAboutTheSameWork(entry: PageEntry, page: readonly PageEntry[]): PageEntry[] {
  const links = readLinksLine(entry);
  if (links === undefined) return [];
  const workOf = pullRequestJoiner(page);
  return page.filter((other) => {
    const otherLinks = readLinksLine(other);
    return other.identity !== entry.identity && otherLinks !== undefined && sameWork(links, otherLinks, workOf);
  });
}

export function saysItIsSuperseded(entry: PageEntry): boolean {
  return linesOf(entry).some((line) => SUPERSEDED_LINE.test(line));
}

export function lineToFixIn(entry: PageEntry): string {
  return linesOf(entry).find((line) => line.startsWith(WHERE_IT_STANDS_PREFIX)) ?? readLinksLine(entry)?.line ?? "";
}
