import type { PullRequestRecords } from "@contract/where-i-stand.ts";
import { isNeedsYouEntry, NO_PULL_REQUEST_WORDS, type PageEntry } from "@/features/where-i-stand/read-page";

const WEB_PROTOCOLS = ["http:", "https:"];
const MISSING_LINK_WORDS = { forgejo: "no Forgejo copy", github: "not on GitHub yet", ticket: "no ticket" };
const KIND_NOT_STATED_WORDS = "kind not stated";
const THRONE_AND_DOTFILES_REPOSITORY_NAMES = ["throne", "dotfiles"];
const THRONE_REPOSITORY_PREFIX = "throne-";

type WorkRecord = PullRequestRecords["rows"][number];

export interface LinkLine {
  readonly words: string;
  readonly address: string | null;
  readonly isMissing: boolean;
  readonly isMarkdown: boolean;
}

export interface WorkRow {
  readonly links: readonly LinkLine[];
  readonly kind: LinkLine;
  readonly title: LinkLine;
  readonly whereItStands: readonly LinkLine[];
  readonly throneOrDotfiles: boolean;
  readonly needsYou: boolean;
}

function webAddress(text: string): string | null {
  try {
    const address = new URL(text.replace(/^<(.*)>$/, "$1"));
    return WEB_PROTOCOLS.includes(address.protocol) ? address.href : null;
  } catch {
    return null;
  }
}

function isThroneOrDotfilesName(name: string | undefined): boolean {
  const repositoryName = (name ?? "").toLowerCase().replace(/\.git$/, "");
  return THRONE_AND_DOTFILES_REPOSITORY_NAMES.includes(repositoryName) || repositoryName.startsWith(THRONE_REPOSITORY_PREFIX);
}

function linkNamesThroneOrDotfiles(link: string | null): boolean {
  const firstWord = (link ?? "").trim().split(/\s+/)[0];
  const address = webAddress(firstWord);
  return isThroneOrDotfilesName(address === null ? firstWord : new URL(address).pathname.split("/")[2]);
}

export function entryIsThroneOrDotfilesWork({ links, kind }: PageEntry): boolean {
  return [links.forgejo, links.github, links.withoutPullRequest].some(linkNamesThroneOrDotfiles) || isThroneOrDotfilesName(kind.split(/\s+/)[0]);
}

function pullRequestAddresses(...addresses: (string | undefined)[]): string[] {
  return addresses.map((address) => webAddress(address ?? "")).filter((address) => address !== null);
}

export function entryNamesRecord(entry: PageEntry, record: WorkRecord): boolean {
  const recordAddresses = pullRequestAddresses(record.forgejo?.url, record.github?.url);
  return pullRequestAddresses(entry.links.forgejo, entry.links.github).some((address) => recordAddresses.includes(address));
}

export function linkLine(label: string, value: string | undefined, missingWords: string): LinkLine {
  const address = webAddress(value ?? "");
  if (address !== null) return { words: label, address, isMissing: false, isMarkdown: false };
  return { words: value || missingWords, address: null, isMissing: !value || value === missingWords, isMarkdown: false };
}

export function numberedLabel(label: string, number: number | undefined): string {
  return number === undefined ? label : `${label} #${number}`;
}

function ticketLine(ticketAddress: string | undefined, ticketId: string): LinkLine {
  return linkLine(ticketId ? `Ticket ${ticketId}` : "Ticket", ticketAddress || ticketId, MISSING_LINK_WORDS.ticket);
}

function recordSummary(record: WorkRecord): string {
  const forgejoState = record.forgejo && `Forgejo ${record.forgejo.state}`.trim();
  const parts = [record.group, forgejoState, record.github ? `GitHub ${record.github.state}`.trim() : "Forgejo only", record.head_commits];
  return [...new Set(parts.filter(Boolean))].join("; ");
}

function plainLine(words: string, isMarkdown: boolean): LinkLine {
  return { words, address: null, isMissing: false, isMarkdown };
}

function linesWithWords(...lines: readonly LinkLine[]): LinkLine[] {
  return lines.filter(({ words }) => words !== "");
}

function rowFromRecord(record: WorkRecord, entry: PageEntry | undefined): WorkRow {
  const ticketAddress = record.ticket_url || webAddress(entry?.links.ticket ?? "") || "";
  return {
    links: [
      linkLine(numberedLabel("Forgejo", record.forgejo?.number), record.forgejo?.url, MISSING_LINK_WORDS.forgejo),
      linkLine(numberedLabel("GitHub", record.github?.number), record.github?.url, MISSING_LINK_WORDS.github),
      ticketAddress || record.ticket ? ticketLine(ticketAddress, record.ticket) : ticketLine(entry?.links.ticket, ""),
    ],
    kind: entry?.kind ? plainLine(entry.kind, true) : plainLine(record.kind || KIND_NOT_STATED_WORDS, false),
    title: record.title ? plainLine(record.title, false) : plainLine(entry?.title ?? "", true),
    whereItStands: linesWithWords(plainLine(recordSummary(record), false), plainLine(entry?.whereItStands ?? "", true)),
    throneOrDotfiles: isThroneOrDotfilesName(record.repository.split("/").at(-1)) || (entry !== undefined && entryIsThroneOrDotfilesWork(entry)),
    needsYou: isNeedsYouEntry(entry),
  };
}

function rowFromEntry(entry: PageEntry): WorkRow {
  const { links } = entry;
  const pullRequestLinks =
    links.withoutPullRequest === null
      ? [linkLine("Forgejo", links.forgejo, MISSING_LINK_WORDS.forgejo), linkLine("GitHub", links.github, MISSING_LINK_WORDS.github)]
      : [plainLine(NO_PULL_REQUEST_WORDS, false), plainLine(links.withoutPullRequest, true)];
  return {
    links: [...pullRequestLinks, ticketLine(links.ticket, "")],
    kind: plainLine(entry.kind || KIND_NOT_STATED_WORDS, true),
    title: plainLine(entry.title || entry.identity, true),
    whereItStands: linesWithWords(plainLine(entry.sectionHeading, false), plainLine(entry.whereItStands, true)),
    throneOrDotfiles: entryIsThroneOrDotfilesWork(entry),
    needsYou: isNeedsYouEntry(entry),
  };
}

export function workRows(records: PullRequestRecords | undefined, currentEntries: readonly PageEntry[]): WorkRow[] {
  const recordsWithEntries = (records?.rows ?? []).map((record) => ({ record, entry: currentEntries.find((entry) => entryNamesRecord(entry, record)) }));
  const ownEntries = currentEntries.filter((entry) => !recordsWithEntries.some((pair) => pair.entry === entry));
  return [
    ...ownEntries.filter(isNeedsYouEntry).map(rowFromEntry),
    ...recordsWithEntries.map(({ record, entry }) => rowFromRecord(record, entry)),
    ...ownEntries.filter((entry) => !isNeedsYouEntry(entry)).map(rowFromEntry),
  ];
}
