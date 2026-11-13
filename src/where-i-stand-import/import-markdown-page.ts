import { readFile, stat } from "node:fs/promises";
import { and, eq, isNull } from "drizzle-orm";
import { openWhereIStandDatabase } from "../where-i-stand-store/where-i-stand-database.ts";
import { isLive, sameName, writeJournal, type Queries } from "../where-i-stand-store/where-i-stand-rules.ts";
import { nextSectionPosition } from "../where-i-stand-store/where-i-stand-structure.ts";
import { contentTable, ContentKind, journalTable, sectionTable, tabTable } from "../where-i-stand-store/where-i-stand.schema.ts";
import { readJournalTimes } from "./markdown-journal-reader.ts";
import { EVENTS_SECTION, readMarkdownPage, type MarkdownEntry } from "./markdown-page-reader.ts";

export const IMPORT_WRITER = "where-i-stand import";
const IMPORT_ACTION = "import";
const TAB_FOR_UNKNOWN_SECTIONS = "Now";

export const TABS_OF_TODAYS_PAGE: readonly { readonly tab: string; readonly sections: readonly string[] }[] = [
  { tab: "Now", sections: ["Needs you", EVENTS_SECTION, "In flight"] },
  { tab: "Epics", sections: ["Epics"] },
  { tab: "Queue", sections: ["Queued and deferred"] },
  { tab: "Delivered", sections: ["Delivered, not on GitHub"] },
  { tab: "Pull requests", sections: ["On GitHub"] },
];

export interface ImportFiles {
  readonly page: string;
  readonly archive: string;
  readonly journal?: string;
}

export interface ImportResult {
  readonly imported: boolean;
  readonly liveRows: number;
  readonly archivedRows: number;
}

interface DatedEntry {
  readonly entry: MarkdownEntry;
  readonly writtenAt: Date;
  readonly writtenDateIsEstimate: boolean;
  readonly archivedAt: Date | null;
  readonly position: number;
}

function tabIdFor(queries: Queries, now: Date, name: string): number {
  const existing = queries.select().from(tabTable).where(isLive(tabTable)).all().find((tab) => sameName(tab.name, name));
  if (existing !== undefined) return existing.id;
  const position = Math.max(-1, ...queries.select().from(tabTable).all().map((tab) => tab.position)) + 1;
  const authorship = { writtenAt: now, writtenBy: IMPORT_WRITER, changedAt: now, changedBy: IMPORT_WRITER };
  return queries.insert(tabTable).values({ name, position, ...authorship }).returning().get().id;
}

function sectionIdFor(queries: Queries, now: Date, tabId: number, name: string): number {
  const siblings = queries.select().from(sectionTable).where(and(eq(sectionTable.tabId, tabId), isNull(sectionTable.parentId), isLive(sectionTable))).all();
  const existing = siblings.find((section) => sameName(section.name, name));
  if (existing !== undefined) return existing.id;
  const authorship = { writtenAt: now, writtenBy: IMPORT_WRITER, changedAt: now, changedBy: IMPORT_WRITER };
  return queries.insert(sectionTable).values({ tabId, name, position: nextSectionPosition(queries, tabId, null), ...authorship }).returning().get().id;
}

function sectionIdsFor(queries: Queries, now: Date, sectionNames: readonly string[]): Map<string, number> {
  const ids = new Map<string, number>();
  for (const { tab, sections } of TABS_OF_TODAYS_PAGE) {
    const tabId = tabIdFor(queries, now, tab);
    for (const section of sections) ids.set(section, sectionIdFor(queries, now, tabId, section));
  }
  const unknownTabId = tabIdFor(queries, now, TAB_FOR_UNKNOWN_SECTIONS);
  for (const section of sectionNames.filter((name) => !ids.has(name))) ids.set(section, sectionIdFor(queries, now, unknownTabId, section));
  return ids;
}

function insertEntry(queries: Queries, sectionId: number, dated: DatedEntry): void {
  const { entry } = dated;
  const isWork = entry.kind === ContentKind.Work;
  queries
    .insert(contentTable)
    .values({
      sectionId,
      kind: entry.kind,
      code: isWork ? entry.identity : null,
      links: entry.links ?? null,
      workKind: entry.workKind ?? null,
      whereItStands: entry.whereItStands ?? null,
      freeLines: entry.freeLines.join("\n"),
      text: isWork ? "" : entry.identity,
      writtenDateIsEstimate: dated.writtenDateIsEstimate,
      position: dated.position,
      writtenAt: dated.writtenAt,
      writtenBy: entry.writtenBy ?? IMPORT_WRITER,
      changedAt: dated.writtenAt,
      changedBy: IMPORT_WRITER,
      archivedAt: dated.archivedAt,
      archivedBy: dated.archivedAt === null ? null : IMPORT_WRITER,
    })
    .run();
}

function placeInSection(entries: readonly MarkdownEntry[]): number[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const place = seen.get(entry.section) ?? 0;
    seen.set(entry.section, place + 1);
    return place;
  });
}

async function modifiedTime(file: string): Promise<Date> {
  return (await stat(file)).mtime;
}

export async function importMarkdownPage(throneHome: string, files: ImportFiles, now: Date = new Date()): Promise<ImportResult> {
  const pageEntries = readMarkdownPage(await readFile(files.page, "utf8"));
  const archiveEntries = readMarkdownPage(await readFile(files.archive, "utf8"));
  const journal = await readJournalTimes(files.journal);
  const pageModified = await modifiedTime(files.page);
  const archiveModified = await modifiedTime(files.archive);
  let eventsSeen = 0;
  const livePlaces = placeInSection(pageEntries);
  const archivedPlaces = placeInSection(archiveEntries);
  const live: DatedEntry[] = pageEntries.map((entry, index) => {
    const noteTime = entry.kind === ContentKind.Event ? journal.notesNewestFirst[eventsSeen++] : undefined;
    const known = entry.writtenOn ?? noteTime;
    return { entry, writtenAt: known ?? pageModified, writtenDateIsEstimate: known === undefined, archivedAt: null, position: livePlaces[index] };
  });
  const archived: DatedEntry[] = archiveEntries.map((entry, index) => ({
    entry,
    writtenAt: entry.writtenOn ?? archiveModified,
    writtenDateIsEstimate: entry.writtenOn === undefined,
    archivedAt: journal.archivedAt.get(entry.identity) ?? now,
    position: archivedPlaces[index],
  }));
  const opened = await openWhereIStandDatabase(throneHome);
  try {
    return opened.database.transaction((queries) => {
      if (queries.select().from(journalTable).where(eq(journalTable.action, IMPORT_ACTION)).get() !== undefined) {
        return { imported: false, liveRows: 0, archivedRows: 0 };
      }
      const sectionIds = sectionIdsFor(queries, now, [...new Set([...live, ...archived].map(({ entry }) => entry.section))]);
      for (const dated of [...archived].reverse()) insertEntry(queries, sectionIds.get(dated.entry.section)!, dated);
      for (const dated of [...live].reverse()) insertEntry(queries, sectionIds.get(dated.entry.section)!, dated);
      const result = { imported: true, liveRows: live.length, archivedRows: archived.length };
      writeJournal(queries, now, { writer: IMPORT_WRITER, action: IMPORT_ACTION, item: "page", after: { ...files, ...result } });
      return result;
    });
  } finally {
    opened.close();
  }
}
