import type { StoredPage, StoredRow, StoredSection, StoredTab } from "@contract/where-i-stand.ts";

export const NEEDS_YOU_HEADING = "Needs you";
export const NO_PULL_REQUEST_WORDS = "no pull request";

const LINK_PART_PATTERN = /^(Forgejo|GitHub|Ticket)\s+(.*)$/;
const LINK_SEPARATOR = " · ";
const KIND_TITLE_SEPARATOR = " — ";

export interface EntryLinks {
  forgejo: string;
  github: string;
  ticket: string;
  withoutPullRequest: string | null;
}

export interface PageEntry {
  readonly id: string;
  readonly sectionHeading: string;
  readonly identity: string;
  readonly markdown: string;
  readonly links: EntryLinks;
  readonly kind: string;
  readonly title: string;
  readonly whereItStands: string;
  readonly row: StoredRow;
}

export interface PageSection {
  readonly id: string;
  readonly tabId: string;
  readonly heading: string;
  readonly depth: number;
  readonly entries: readonly PageEntry[];
  readonly archivedRowCount: number;
  readonly subsections: readonly PageSection[];
}

export interface ReadPage {
  readonly tabs: readonly StoredTab[];
  readonly sections: readonly PageSection[];
  readonly archivedSections: readonly StoredSection[];
  readonly entries: readonly PageEntry[];
  readonly listingToken: string;
  readonly lastChangedAt: string | undefined;
}

function readLinksLine(linksLine: string): EntryLinks {
  const parts = linksLine.split(LINK_SEPARATOR).map((part) => part.trim());
  const links: EntryLinks = { forgejo: "", github: "", ticket: "", withoutPullRequest: null };
  if (parts[0] === NO_PULL_REQUEST_WORDS) links.withoutPullRequest = LINK_PART_PATTERN.test(parts[1] ?? "") ? "" : (parts[1] ?? "");
  for (const part of parts) {
    const linkPart = LINK_PART_PATTERN.exec(part);
    if (linkPart === null) continue;
    const linkName = linkPart[1].toLowerCase() as "forgejo" | "github" | "ticket";
    links[linkName] = linkPart[2].trim();
  }
  return links;
}

function headingMarks(depth: number): string {
  return "#".repeat(depth + 2);
}

export function epicMarkdownOf(title: string, notes: readonly string[]): string {
  return [`### ${title}`, ...notes].join("\n");
}

function rowMarkdown(row: StoredRow, depth: number): string {
  if (row.kind === "event") return `- ${row.text}`;
  if (row.kind === "epic") return epicMarkdownOf(row.text, row.freeLines);
  const fieldLines = [
    ["Links", row.links],
    ["Kind", row.workKind],
    ["Where it stands", row.whereItStands],
  ].flatMap(([label, value]) => (value === null ? [] : [`- ${label}: ${value}`]));
  return [`${headingMarks(depth)} ${row.code ?? ""}`, ...fieldLines, ...row.freeLines].join("\n");
}

export function entryOfRow(row: StoredRow, sectionHeading: string, depth = 1): PageEntry {
  const [kind, ...titleParts] = (row.workKind ?? "").split(KIND_TITLE_SEPARATOR);
  return {
    id: row.id,
    sectionHeading,
    identity: row.kind === "work" ? (row.code ?? "") : row.text,
    markdown: rowMarkdown(row, depth),
    links: readLinksLine(row.links ?? ""),
    kind: kind.trim(),
    title: titleParts.join(KIND_TITLE_SEPARATOR).trim(),
    whereItStands: row.whereItStands ?? "",
    row,
  };
}

function byPosition<Item extends { position: number }>(items: readonly Item[]): Item[] {
  return [...items].sort((first, second) => first.position - second.position);
}

function inPageOrder(tabs: readonly StoredTab[], sections: readonly PageSection[]): PageSection[] {
  const tabPosition = (section: PageSection) => tabs.findIndex((tab) => tab.id === section.tabId);
  return [...sections].sort((first, second) => tabPosition(first) - tabPosition(second));
}

function newestOf(times: readonly string[]): string | undefined {
  return times.reduce<string | undefined>((newest, time) => (newest === undefined || time > newest ? time : newest), undefined);
}

export function readPage({ listing, rows, archivedRowCounts }: StoredPage): ReadPage {
  const liveSections = byPosition(listing.sections.filter((section) => section.archivedAt === null));
  function sectionOf(section: StoredSection, depth: number): PageSection {
    return {
      id: section.id,
      tabId: section.tabId,
      heading: section.name,
      depth,
      entries: rows.filter((row) => row.sectionId === section.id).map((row) => entryOfRow(row, section.name, depth)),
      archivedRowCount: archivedRowCounts[section.id] ?? 0,
      subsections: liveSections.filter((child) => child.parentId === section.id).map((child) => sectionOf(child, depth + 1)),
    };
  }
  const sections = liveSections.filter((section) => section.parentId === null).map((section) => sectionOf(section, 1));
  const tabs = byPosition(listing.tabs.filter((tab) => tab.archivedAt === null));
  const entriesOf = (section: PageSection): PageEntry[] => [...section.entries, ...section.subsections.flatMap(entriesOf)];
  const entriesUnderTopHeading = (section: PageSection): PageEntry[] => entriesOf(section).map((entry) => ({ ...entry, sectionHeading: section.heading }));
  return {
    tabs,
    sections,
    archivedSections: listing.sections.filter((section) => section.archivedAt !== null),
    entries: inPageOrder(tabs, sections).flatMap(entriesUnderTopHeading),
    listingToken: listing.listingToken,
    lastChangedAt: newestOf([...rows.map((row) => row.changedAt), ...listing.sections.map((section) => section.changedAt), ...listing.tabs.map((tab) => tab.changedAt)]),
  };
}

export function isNeedsYouEntry(entry: PageEntry | undefined): boolean {
  return entry?.sectionHeading === NEEDS_YOU_HEADING;
}
