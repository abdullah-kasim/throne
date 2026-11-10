import {
  DELIVERED_ENTRIES_KEPT,
  DELIVERED_ENTRY_DAYS_KEPT,
  entryHeadingOf,
  listEntries,
  PageSection,
  sectionHeadingOf,
  sectionNamedBy,
  type PageEntry,
} from "./page-frame.ts";

export interface ArchivedEntry {
  readonly section: string;
  readonly identity: string;
  readonly text: string;
}

export interface TrimmedPage {
  readonly page: string;
  readonly archived: readonly ArchivedEntry[];
}

const WRITTEN_ON_DATE = /Written by [^\n]*?(\d{4}-\d{2}-\d{2})/;
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

function writtenOn(body: string): Date | undefined {
  const date = WRITTEN_ON_DATE.exec(body)?.[1];
  if (date === undefined) return undefined;
  const written = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(written.getTime()) ? undefined : written;
}

function isRecent(entry: PageEntry, now: Date): boolean {
  const written = writtenOn(entry.body);
  return written !== undefined && now.getTime() - written.getTime() < DELIVERED_ENTRY_DAYS_KEPT * DAY_IN_MILLISECONDS;
}

function wholeTextOf(entry: PageEntry): string {
  return `${entryHeadingOf(entry.identity)}\n${entry.body}`;
}

function withoutEntriesInSection(content: string, section: string, removedPositions: ReadonlySet<number>): string {
  const kept: string[] = [];
  let currentSection: string | undefined;
  let skipping = false;
  let position = -1;
  for (const line of content.split("\n")) {
    const named = sectionNamedBy(line);
    if (named !== undefined) {
      currentSection = named;
      skipping = false;
    } else if (currentSection === section && line.startsWith(entryHeadingOf(""))) {
      position += 1;
      skipping = removedPositions.has(position);
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

export function trimPage(content: string, now: Date): TrimmedPage {
  const section = PageSection.DeliveredNotOnGitHub;
  const delivered = listEntries(content).filter((entry) => entry.section === section);
  const isArchived = (entry: PageEntry, position: number): boolean => position >= DELIVERED_ENTRIES_KEPT && !isRecent(entry, now);
  const archivedPositions = new Set(delivered.flatMap((entry, position) => (isArchived(entry, position) ? [position] : [])));
  if (archivedPositions.size === 0) return { page: content, archived: [] };
  const archivedEntries = delivered.filter((_entry, position) => archivedPositions.has(position));
  return {
    page: withoutEntriesInSection(content, section, archivedPositions),
    archived: archivedEntries.map((entry) => ({ section, identity: entry.identity, text: wholeTextOf(entry) })),
  };
}

function withEntriesOnTopOfSection(archive: string, section: string, texts: readonly string[]): string {
  const heading = sectionHeadingOf(section);
  const block = texts.map((text) => `${text.trimEnd()}\n\n`).join("");
  const lines = archive.split("\n");
  const headingAt = lines.indexOf(heading);
  if (headingAt === -1) {
    const separator = archive === "" || archive.endsWith("\n\n") ? "" : archive.endsWith("\n") ? "\n" : "\n\n";
    return `${archive}${separator}${heading}\n\n${block}`;
  }
  const before = lines.slice(0, headingAt + 1).join("\n");
  const after = lines.slice(headingAt + 1).join("\n").replace(/^\n/, "");
  return `${before}\n\n${block}${after}`;
}

export function archiveWith(archive: string, archived: readonly ArchivedEntry[]): string {
  const sections = [...new Set(archived.map((entry) => entry.section))];
  return sections.reduce(
    (text, section) =>
      withEntriesOnTopOfSection(
        text,
        section,
        archived.filter((entry) => entry.section === section).map((entry) => entry.text),
      ),
    archive,
  );
}
