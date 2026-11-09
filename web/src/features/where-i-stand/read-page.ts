import { ENTRY_HEADING_LEVEL, entryEnd, headingLevelOf, headingTextOf, SECTION_HEADING_LEVEL } from "@contract/page-entry-lines.ts";

export const NEEDS_YOU_HEADING = "Needs you";
export const NO_PULL_REQUEST_WORDS = "no pull request";

const ENTRY_LINE_PATTERN = /^\s*[-*+]\s+(Links|Kind|Where it stands):\s*(.*)$/;
const LINK_PART_PATTERN = /^(Forgejo|GitHub|Ticket)\s+(.*)$/;
const SUPERSEDED_LINE_PATTERN = /^\s*(?:- )?Superseded by `### /;
const LINK_SEPARATOR = " · ";
const KIND_TITLE_SEPARATOR = " — ";

export interface EntryLinks {
  forgejo: string;
  github: string;
  ticket: string;
  withoutPullRequest: string | null;
}

export interface PageEntry {
  readonly sectionHeading: string;
  readonly identity: string;
  readonly markdown: string;
  readonly links: EntryLinks;
  readonly kind: string;
  readonly title: string;
  readonly whereItStands: string;
  readonly superseded: boolean;
}

export interface PageSection {
  readonly heading: string;
  readonly opening: string;
  readonly entries: readonly PageEntry[];
}

interface SectionBeingRead {
  readonly heading: string;
  readonly openingLines: string[];
  readonly entries: PageEntry[];
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

function firstValuesOfEntryLines(lines: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of lines) {
    const entryLine = ENTRY_LINE_PATTERN.exec(line);
    if (entryLine !== null && !values.has(entryLine[1])) values.set(entryLine[1], entryLine[2].trim());
  }
  return values;
}

function readEntry(sectionHeading: string, lines: readonly string[]): PageEntry {
  const values = firstValuesOfEntryLines(lines);
  const [kind, ...titleParts] = (values.get("Kind") ?? "").split(KIND_TITLE_SEPARATOR);
  return {
    sectionHeading,
    identity: headingTextOf(lines[0]),
    markdown: lines.join("\n"),
    links: readLinksLine(values.get("Links") ?? ""),
    kind: kind.trim(),
    title: titleParts.join(KIND_TITLE_SEPARATOR).trim(),
    whereItStands: values.get("Where it stands") ?? "",
    superseded: lines.some((line) => SUPERSEDED_LINE_PATTERN.test(line)),
  };
}

function hasSomethingToShow({ openingLines, entries }: SectionBeingRead): boolean {
  return entries.length > 0 || openingLines.some((line) => line.trim() !== "");
}

export function readPage(markdown: string): PageSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: SectionBeingRead[] = [{ heading: "", openingLines: [], entries: [] }];
  for (let position = 0; position < lines.length; position += 1) {
    const line = lines[position];
    const section = sections[sections.length - 1];
    const level = headingLevelOf(line);
    if (level === SECTION_HEADING_LEVEL) {
      sections.push({ heading: headingTextOf(line), openingLines: [line], entries: [] });
    } else if (level === ENTRY_HEADING_LEVEL) {
      const end = entryEnd(lines, position);
      section.entries.push(readEntry(section.heading, lines.slice(position, end)));
      position = end - 1;
    } else section.openingLines.push(line);
  }
  return sections.filter(hasSomethingToShow).map(({ heading, openingLines, entries }) => ({ heading, opening: openingLines.join("\n"), entries }));
}

export function isNeedsYouEntry(entry: PageEntry | undefined): boolean {
  return entry?.sectionHeading === NEEDS_YOU_HEADING;
}
