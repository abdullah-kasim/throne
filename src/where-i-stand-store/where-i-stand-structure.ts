import { and, asc, eq, isNull } from "drizzle-orm";
import type { StructureListing } from "../web-api-contract/where-i-stand.ts";
import { IdPrefix, sectionToContract, shortId, tabToContract } from "./row-to-contract.ts";
import { listingTokenOf, writeJournal, type Queries } from "./where-i-stand-rules.ts";
import { contentTable, sectionTable, tabTable, type SectionRow } from "./where-i-stand.schema.ts";

export function readListing(queries: Queries): StructureListing {
  const tabs = queries.select().from(tabTable).orderBy(asc(tabTable.position), asc(tabTable.id)).all();
  const sections = queries.select().from(sectionTable).orderBy(asc(sectionTable.position), asc(sectionTable.id)).all();
  return {
    tabs: tabs.map(tabToContract),
    sections: sections.map(sectionToContract),
    listingToken: listingTokenOf(
      [...tabs].sort((first, second) => first.id - second.id),
      [...sections].sort((first, second) => first.id - second.id),
    ),
  };
}

export function nextSectionPosition(queries: Queries, tabId: number, parentId: number | null): number {
  const siblings = queries
    .select({ position: sectionTable.position })
    .from(sectionTable)
    .where(and(eq(sectionTable.tabId, tabId), parentId === null ? isNull(sectionTable.parentId) : eq(sectionTable.parentId, parentId)))
    .all();
  return Math.max(-1, ...siblings.map((sibling) => sibling.position)) + 1;
}

function sectionById(queries: Queries, id: number): SectionRow | undefined {
  return queries.select().from(sectionTable).where(eq(sectionTable.id, id)).get();
}

export function reviveSectionAndItsParents(queries: Queries, now: Date, writer: string, section: SectionRow): SectionRow[] {
  const revived: SectionRow[] = [];
  let current: SectionRow | undefined = section;
  while (current !== undefined) {
    if (current.archivedAt !== null) {
      const after = { ...current, archivedAt: null, archivedBy: null, changedAt: now, changedBy: writer };
      queries.update(sectionTable).set({ archivedAt: null, archivedBy: null, changedAt: now, changedBy: writer }).where(eq(sectionTable.id, current.id)).run();
      writeJournal(queries, now, { writer, action: "revive", item: shortId(IdPrefix.Section, current.id), before: current, after });
      revived.push(after);
    }
    current = current.parentId === null ? undefined : sectionById(queries, current.parentId);
  }
  return revived;
}

function sectionAndItsSubsections(queries: Queries, top: SectionRow): SectionRow[] {
  const inside = queries.select().from(sectionTable).where(eq(sectionTable.parentId, top.id)).all();
  return [top, ...inside.flatMap((section) => sectionAndItsSubsections(queries, section))];
}

export function archiveSectionWithItsRows(queries: Queries, now: Date, writer: string, top: SectionRow): void {
  for (const section of sectionAndItsSubsections(queries, top).filter((each) => each.archivedAt === null)) {
    queries.update(sectionTable).set({ archivedAt: now, archivedBy: writer }).where(eq(sectionTable.id, section.id)).run();
    writeJournal(queries, now, { writer, action: "archive", item: shortId(IdPrefix.Section, section.id), before: section, after: { ...section, archivedAt: now, archivedBy: writer } });
    const liveRows = queries.select().from(contentTable).where(and(eq(contentTable.sectionId, section.id), isNull(contentTable.archivedAt))).all();
    for (const row of liveRows) {
      queries.update(contentTable).set({ archivedAt: now, archivedBy: writer }).where(eq(contentTable.id, row.id)).run();
      writeJournal(queries, now, { writer, action: "archive", item: shortId(IdPrefix.Row, row.id), before: row, after: { ...row, archivedAt: now, archivedBy: writer } });
    }
  }
}

export function restoreSectionWithItsRows(queries: Queries, now: Date, writer: string, top: SectionRow): void {
  const archivedTogetherAt = top.archivedAt;
  if (archivedTogetherAt === null) return;
  reviveSectionAndItsParents(queries, now, writer, top);
  const together = sectionAndItsSubsections(queries, top).filter(
    (section) => section.id === top.id || section.archivedAt?.getTime() === archivedTogetherAt.getTime(),
  );
  for (const section of together) {
    if (section.id !== top.id) reviveSectionAndItsParents(queries, now, writer, section);
    const rows = queries.select().from(contentTable).where(and(eq(contentTable.sectionId, section.id), eq(contentTable.archivedAt, archivedTogetherAt))).all();
    for (const row of rows) {
      queries.update(contentTable).set({ archivedAt: null, archivedBy: null, changedAt: now, changedBy: writer }).where(eq(contentTable.id, row.id)).run();
      writeJournal(queries, now, { writer, action: "restore", item: shortId(IdPrefix.Row, row.id), before: row, after: { ...row, archivedAt: null, archivedBy: null } });
    }
  }
}
