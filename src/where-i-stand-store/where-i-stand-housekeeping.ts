import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { PurgedItem } from "../web-api-contract/where-i-stand.ts";
import { IdPrefix, shortId } from "./row-to-contract.ts";
import {
  DELIVERED_ROWS_KEPT,
  DELIVERED_TAB_NAME,
  deliveredKeptSince,
  HOUSEKEEPING_WRITER,
  isArchived,
  isLive,
  LIVE_EVENT_LINES,
  purgeCutoff,
  sameName,
  writeJournal,
  type Queries,
} from "./where-i-stand-rules.ts";
import { contentTable, ContentKind, sectionTable, tabTable, type ContentRow, type SectionRow } from "./where-i-stand.schema.ts";

function archiveRowsByHousekeeping(queries: Queries, now: Date, rows: readonly ContentRow[], action: string): void {
  for (const row of rows) {
    const after = { ...row, archivedAt: now, archivedBy: HOUSEKEEPING_WRITER };
    queries.update(contentTable).set({ archivedAt: now, archivedBy: HOUSEKEEPING_WRITER }).where(eq(contentTable.id, row.id)).run();
    writeJournal(queries, now, { writer: HOUSEKEEPING_WRITER, action, item: shortId(IdPrefix.Row, row.id), before: row, after });
  }
}

function rowsBySection(rows: readonly ContentRow[]): Map<number, ContentRow[]> {
  const grouped = new Map<number, ContentRow[]>();
  for (const row of rows) grouped.set(row.sectionId, [...(grouped.get(row.sectionId) ?? []), row]);
  return grouped;
}

function capEventLines(queries: Queries, now: Date, keptLiveRowId: number | undefined): void {
  const events = queries
    .select()
    .from(contentTable)
    .where(and(eq(contentTable.kind, ContentKind.Event), isLive(contentTable)))
    .orderBy(desc(contentTable.writtenAt), desc(contentTable.id))
    .all();
  for (const sectionEvents of rowsBySection(events).values()) {
    const others = sectionEvents.filter((row) => row.id !== keptLiveRowId);
    const room = others.length === sectionEvents.length ? LIVE_EVENT_LINES : LIVE_EVENT_LINES - 1;
    archiveRowsByHousekeeping(queries, now, others.slice(room), "event cap");
  }
}

function deliveredSectionIds(queries: Queries): number[] {
  const deliveredTabIds = queries
    .select()
    .from(tabTable)
    .all()
    .filter((tab) => sameName(tab.name, DELIVERED_TAB_NAME))
    .map((tab) => tab.id);
  if (deliveredTabIds.length === 0) return [];
  return queries
    .select({ id: sectionTable.id })
    .from(sectionTable)
    .where(inArray(sectionTable.tabId, deliveredTabIds))
    .all()
    .map((section) => section.id);
}

function trimDelivered(queries: Queries, now: Date): void {
  const sectionIds = deliveredSectionIds(queries);
  if (sectionIds.length === 0) return;
  const keptSince = deliveredKeptSince(now);
  const delivered = queries
    .select()
    .from(contentTable)
    .where(and(inArray(contentTable.sectionId, sectionIds), eq(contentTable.kind, ContentKind.Work), isLive(contentTable)))
    .orderBy(desc(contentTable.changedAt), desc(contentTable.id))
    .all();
  for (const sectionRows of rowsBySection(delivered).values()) {
    const tooOld = sectionRows.slice(DELIVERED_ROWS_KEPT).filter((row) => row.changedAt < keptSince);
    archiveRowsByHousekeeping(queries, now, tooOld, "delivered trim");
  }
}

function sectionAndEverythingInside(sections: readonly SectionRow[], top: SectionRow): SectionRow[] {
  const inside = sections.filter((section) => section.parentId === top.id);
  return [top, ...inside.flatMap((section) => sectionAndEverythingInside(sections, section))];
}

function rowWords(row: ContentRow): string {
  return row.code ?? row.text;
}

function findPurgeable(queries: Queries, now: Date): { sections: SectionRow[]; rows: ContentRow[]; items: PurgedItem[] } {
  const cutoff = purgeCutoff(now);
  const allSections = queries.select().from(sectionTable).all();
  const expiredSections = allSections.filter((section) => section.archivedAt !== null && section.archivedAt < cutoff);
  const sections = [...new Map(expiredSections.flatMap((top) => sectionAndEverythingInside(allSections, top)).map((section) => [section.id, section])).values()];
  const sectionIds = new Set(sections.map((section) => section.id));
  const expiredRows = queries.select().from(contentTable).where(and(isArchived(contentTable), lt(contentTable.archivedAt, cutoff))).all();
  const rowsInside = sectionIds.size === 0 ? [] : queries.select().from(contentTable).where(inArray(contentTable.sectionId, [...sectionIds])).all();
  const rows = [...new Map([...expiredRows, ...rowsInside].map((row) => [row.id, row])).values()];
  const items: PurgedItem[] = [
    ...sections.map((section) => ({ item: shortId(IdPrefix.Section, section.id), words: section.name, archivedAt: (section.archivedAt ?? now).toISOString() })),
    ...rows.map((row) => ({ item: shortId(IdPrefix.Row, row.id), words: rowWords(row), archivedAt: (row.archivedAt ?? now).toISOString() })),
  ];
  return { sections, rows, items };
}

export function purgeArchived(queries: Queries, now: Date, dryRun: boolean, writer: string): PurgedItem[] {
  const purgeable = findPurgeable(queries, now);
  if (dryRun) return purgeable.items;
  for (const row of purgeable.rows) {
    queries.delete(contentTable).where(eq(contentTable.id, row.id)).run();
    writeJournal(queries, now, { writer, action: "purge", item: shortId(IdPrefix.Row, row.id), before: row });
  }
  for (const section of [...purgeable.sections].reverse()) {
    queries.delete(sectionTable).where(eq(sectionTable.id, section.id)).run();
    writeJournal(queries, now, { writer, action: "purge", item: shortId(IdPrefix.Section, section.id), before: section });
  }
  return purgeable.items;
}

export function keepHouseOnWrite(queries: Queries, now: Date, keptLiveRowId?: number): void {
  capEventLines(queries, now, keptLiveRowId);
  trimDelivered(queries, now);
  purgeArchived(queries, now, false, HOUSEKEEPING_WRITER);
}
