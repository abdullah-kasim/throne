import { Injectable, type OnModuleDestroy, type OnModuleInit, Optional } from "@nestjs/common";
import { and, asc, count, desc, eq, inArray, isNull, min, ne } from "drizzle-orm";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";
import type {
  AddRowRequest,
  ArchivedRowsResponse,
  CreateSectionRequest,
  CreateTabRequest,
  PurgeRequest,
  PurgeResponse,
  ReplaceRowRequest,
  RowFields,
  StoredPage,
  StructureListing,
  WriteResponse,
  WriterRequest,
} from "../web-api-contract/where-i-stand.ts";
import { IdPrefix, numberOfShortId, rowToContract, sectionToContract, shortId, tabToContract } from "./row-to-contract.ts";
import { keepHouseOnWrite, purgeArchived } from "./where-i-stand-housekeeping.ts";
import { HOUSEKEEPING_WRITER, isArchived, isLive, sameName, writeJournal, type Queries } from "./where-i-stand-rules.ts";
import {
  archiveSectionWithItsRows,
  nextSectionPosition,
  readListing,
  restoreSectionWithItsRows,
  reviveSectionAndItsParents,
} from "./where-i-stand-structure.ts";
import { openWhereIStandDatabase, type WhereIStandDatabase, type WhereIStandDatabaseHandle } from "./where-i-stand-database.ts";
import { contentTable, ContentKind, sectionTable, tabTable, type ContentRow, type SectionRow } from "./where-i-stand.schema.ts";

export interface WhereIStandOperations {
  listing(): Promise<StructureListing>;
  page(): Promise<StoredPage>;
  archivedRows(sectionId: string): Promise<ArchivedRowsResponse>;
  addRow(request: AddRowRequest): Promise<WriteResponse>;
  replaceRow(rowId: string, request: ReplaceRowRequest): Promise<WriteResponse>;
  archiveRow(rowId: string, request: WriterRequest): Promise<WriteResponse>;
  restoreRow(rowId: string, request: WriterRequest): Promise<WriteResponse>;
  archiveSection(sectionId: string, request: WriterRequest): Promise<WriteResponse>;
  restoreSection(sectionId: string, request: WriterRequest): Promise<WriteResponse>;
  createTab(request: CreateTabRequest): Promise<WriteResponse>;
  createSection(request: CreateSectionRequest): Promise<WriteResponse>;
  purge(request: PurgeRequest): Promise<PurgeResponse>;
}

export type WhereIStandClock = () => Date;

export const whereIStandClock = { now: (): Date => new Date() };

const PURGE_EVERY_MS = 60_000;
const WORK_FIELDS = [
  ["code", "an objective code or repository and pull request number"],
  ["links", "links"],
  ["workKind", "kind"],
  ["whereItStands", "where it stands"],
] as const;

function refused(message: string, extra: Partial<WriteResponse> = {}): WriteResponse {
  return { outcome: "refused", message, ...extra };
}

function missingWorkField(fields: RowFields): string | undefined {
  return WORK_FIELDS.find(([field]) => !fields[field]?.trim())?.[1];
}

function revivedSectionNotice(section: SectionRow): string {
  return `Section ${shortId(IdPrefix.Section, section.id)} "${section.name}" was archived and is revived; its archived rows stay archived.`;
}

function currentFields(row: ContentRow): RowFields {
  return {
    kind: row.kind,
    code: row.code ?? undefined,
    links: row.links ?? undefined,
    workKind: row.workKind ?? undefined,
    whereItStands: row.whereItStands ?? undefined,
    freeLines: rowToContract(row).freeLines,
    text: row.text,
  };
}

function storedFields(fields: Omit<RowFields, "kind">) {
  return {
    code: fields.code?.trim() || null,
    links: fields.links?.trim() || null,
    workKind: fields.workKind?.trim() || null,
    whereItStands: fields.whereItStands?.trim() || null,
    freeLines: (fields.freeLines ?? []).join("\n"),
    text: fields.text?.trim() ?? "",
  };
}

function laterThan(previous: Date, now: Date): Date {
  return new Date(Math.max(now.getTime(), previous.getTime() + 1));
}

@Injectable()
export class WhereIStandStore implements WhereIStandOperations, OnModuleInit, OnModuleDestroy {
  private opened: Promise<WhereIStandDatabase> | undefined;
  private purgeTimer: NodeJS.Timeout | undefined;

  constructor(
    @Optional() private readonly throneHome: string = resolveThroneHome(),
    @Optional() private readonly clock: WhereIStandClock = () => whereIStandClock.now(),
  ) {}

  private async database(): Promise<WhereIStandDatabaseHandle> {
    this.opened ??= openWhereIStandDatabase(this.throneHome);
    return (await this.opened).database;
  }

  private async write<Result>(work: (queries: Queries, now: Date) => Result, keptLiveRowId?: number): Promise<Result> {
    const database = await this.database();
    const now = this.clock();
    return database.transaction((transaction) => {
      const result = work(transaction, now);
      if ((result as WriteResponse | undefined)?.outcome !== "refused") keepHouseOnWrite(transaction, now, keptLiveRowId);
      return result;
    });
  }

  private refusalIfTokenIsStale(queries: Queries, listingToken: string): WriteResponse | undefined {
    const listing = readListing(queries);
    if (listing.listingToken === listingToken) return undefined;
    return refused("The listing token is out of date: the tabs or sections changed since it was read. Here is the current listing.", { listing });
  }

  private sectionOf(queries: Queries, sectionId: string): SectionRow | undefined {
    const id = numberOfShortId(IdPrefix.Section, sectionId);
    return id === undefined ? undefined : queries.select().from(sectionTable).where(eq(sectionTable.id, id)).get();
  }

  private rowOf(queries: Queries, rowId: string): ContentRow | undefined {
    const id = numberOfShortId(IdPrefix.Row, rowId);
    return id === undefined ? undefined : queries.select().from(contentTable).where(eq(contentTable.id, id)).get();
  }

  private liveWorkRowWithCode(queries: Queries, code: string, otherThan?: number): ContentRow | undefined {
    const conditions = [eq(contentTable.kind, ContentKind.Work), eq(contentTable.code, code), isLive(contentTable)];
    if (otherThan !== undefined) conditions.push(ne(contentTable.id, otherThan));
    return queries.select().from(contentTable).where(and(...conditions)).get();
  }

  private topPositionOf(queries: Queries, sectionId: number): number {
    const top = queries.select({ position: min(contentTable.position) }).from(contentTable).where(eq(contentTable.sectionId, sectionId)).get();
    return (top?.position ?? 1) - 1;
  }

  async listing(): Promise<StructureListing> {
    return readListing(await this.database());
  }

  async page(): Promise<StoredPage> {
    const database = await this.database();
    const listing = readListing(database);
    const liveSectionIds = database.select({ id: sectionTable.id }).from(sectionTable).where(isLive(sectionTable)).all().map((section) => section.id);
    const rows =
      liveSectionIds.length === 0
        ? []
        : database
            .select()
            .from(contentTable)
            .where(and(isLive(contentTable), inArray(contentTable.sectionId, liveSectionIds)))
            .orderBy(asc(contentTable.position), desc(contentTable.id))
            .all();
    const archivedCounts = database
      .select({ sectionId: contentTable.sectionId, archived: count() })
      .from(contentTable)
      .where(isArchived(contentTable))
      .groupBy(contentTable.sectionId)
      .all();
    return {
      now: this.clock().toISOString(),
      listing,
      rows: rows.map(rowToContract),
      archivedRowCounts: Object.fromEntries(archivedCounts.map(({ sectionId, archived }) => [shortId(IdPrefix.Section, sectionId), archived])),
    };
  }

  async archivedRows(sectionId: string): Promise<ArchivedRowsResponse> {
    const database = await this.database();
    const section = this.sectionOf(database, sectionId);
    if (section === undefined) return { rows: [] };
    const rows = database
      .select()
      .from(contentTable)
      .where(and(eq(contentTable.sectionId, section.id), isArchived(contentTable)))
      .orderBy(desc(contentTable.archivedAt), desc(contentTable.id))
      .all();
    return { rows: rows.map(rowToContract) };
  }

  async addRow(request: AddRowRequest): Promise<WriteResponse> {
    if (numberOfShortId(IdPrefix.Section, request.sectionId) === undefined) {
      return refused(`"${request.sectionId}" is not a section id. Name a section by the id \`list\` prints, such as s3, never by its name.`);
    }
    const { row: fields } = request;
    if (fields.kind === ContentKind.Work) {
      const missing = missingWorkField(fields);
      if (missing !== undefined) return refused(`A work entry needs ${missing}; it was missing, and nothing was written.`);
    } else if (!fields.text?.trim()) {
      return refused(`A ${fields.kind} line needs its text; it was missing, and nothing was written.`);
    }
    return this.write((queries, now) => {
      const staleToken = this.refusalIfTokenIsStale(queries, request.listingToken);
      if (staleToken !== undefined) return staleToken;
      const section = this.sectionOf(queries, request.sectionId);
      if (section === undefined) return refused(`There is no section ${request.sectionId}.`, { listing: readListing(queries) });
      const revived = reviveSectionAndItsParents(queries, now, request.writer, section);
      const notices = revived.map(revivedSectionNotice);
      const values = { sectionId: section.id, kind: fields.kind, ...storedFields(fields), changedAt: now, changedBy: request.writer };
      const existing = fields.kind === ContentKind.Work ? this.liveWorkRowWithCode(queries, values.code ?? "") : undefined;
      if (existing !== undefined) {
        const position = existing.sectionId === section.id ? existing.position : this.topPositionOf(queries, section.id);
        const replaced = queries.update(contentTable).set({ ...values, position, changedAt: laterThan(existing.changedAt, now) }).where(eq(contentTable.id, existing.id)).returning().get();
        writeJournal(queries, now, { writer: request.writer, action: "replace", item: shortId(IdPrefix.Row, existing.id), before: existing, after: replaced });
        return { outcome: "done", message: [...notices, `Replaced the live row ${shortId(IdPrefix.Row, existing.id)} for ${existing.code}.`].join(" "), row: rowToContract(replaced) };
      }
      const position = this.topPositionOf(queries, section.id);
      const added = queries.insert(contentTable).values({ ...values, position, writtenAt: now, writtenBy: request.writer }).returning().get();
      writeJournal(queries, now, { writer: request.writer, action: "add", item: shortId(IdPrefix.Row, added.id), after: added });
      return { outcome: "done", message: [...notices, `Added ${shortId(IdPrefix.Row, added.id)}.`].join(" "), row: rowToContract(added) };
    });
  }

  async replaceRow(rowId: string, request: ReplaceRowRequest): Promise<WriteResponse> {
    return this.write((queries, now) => {
      const current = this.rowOf(queries, rowId);
      if (current === undefined) return refused(`There is no row ${rowId}.`);
      if (current.archivedAt !== null) return refused(`Row ${rowId} is archived; restore it before changing it.`, { row: rowToContract(current) });
      if (current.kind === ContentKind.Epic && request.loadedChangedAt !== current.changedAt.toISOString()) {
        return refused("Not saved: this epic changed since it was loaded, and nothing was overwritten. Here is the current one.", { row: rowToContract(current) });
      }
      const merged: RowFields = { ...currentFields(current), ...request.row };
      if (current.kind === ContentKind.Work) {
        const missing = missingWorkField(merged);
        if (missing !== undefined) return refused(`A work entry needs ${missing}; it was missing, and nothing was written.`, { row: rowToContract(current) });
        const holder = this.liveWorkRowWithCode(queries, merged.code!.trim(), current.id);
        if (holder !== undefined) return refused(`${merged.code} already has the live row ${shortId(IdPrefix.Row, holder.id)}.`, { row: rowToContract(current) });
      }
      const values = storedFields(merged);
      const replaced = queries.update(contentTable).set({ ...values, changedAt: laterThan(current.changedAt, now), changedBy: request.writer }).where(eq(contentTable.id, current.id)).returning().get();
      writeJournal(queries, now, { writer: request.writer, action: "replace", item: rowId, before: current, after: replaced });
      return { outcome: "done", message: `Saved ${rowId}.`, row: rowToContract(replaced) };
    });
  }

  async archiveRow(rowId: string, request: WriterRequest): Promise<WriteResponse> {
    return this.write((queries, now) => {
      const current = this.rowOf(queries, rowId);
      if (current === undefined) return refused(`There is no row ${rowId}.`);
      if (current.archivedAt !== null) return { outcome: "done", message: `Row ${rowId} was already archived.`, row: rowToContract(current) };
      if (request.loadedChangedAt !== undefined && request.loadedChangedAt !== current.changedAt.toISOString()) {
        return refused(`Not archived: row ${rowId} changed since it was loaded. Here is the current one.`, { row: rowToContract(current) });
      }
      const archived = queries.update(contentTable).set({ archivedAt: now, archivedBy: request.writer }).where(eq(contentTable.id, current.id)).returning().get();
      writeJournal(queries, now, { writer: request.writer, action: "archive", item: rowId, before: current, after: archived });
      return { outcome: "done", message: `Archived ${rowId}.`, row: rowToContract(archived) };
    });
  }

  async restoreRow(rowId: string, request: WriterRequest): Promise<WriteResponse> {
    return this.write((queries, now) => {
      const current = this.rowOf(queries, rowId);
      if (current === undefined) return refused(`There is no row ${rowId}.`);
      if (current.archivedAt === null) return { outcome: "done", message: `Row ${rowId} is already live.`, row: rowToContract(current) };
      const holder = current.kind === ContentKind.Work && current.code !== null ? this.liveWorkRowWithCode(queries, current.code) : undefined;
      if (holder !== undefined) return refused(`${current.code} already has the live row ${shortId(IdPrefix.Row, holder.id)}; archive it first.`, { row: rowToContract(current) });
      const section = queries.select().from(sectionTable).where(eq(sectionTable.id, current.sectionId)).get();
      const revived = section === undefined ? [] : reviveSectionAndItsParents(queries, now, request.writer, section);
      const restored = queries.update(contentTable).set({ archivedAt: null, archivedBy: null, changedAt: laterThan(current.changedAt, now), changedBy: request.writer }).where(eq(contentTable.id, current.id)).returning().get();
      writeJournal(queries, now, { writer: request.writer, action: "restore", item: rowId, before: current, after: restored });
      const notices = revived.map((each) => `Section ${shortId(IdPrefix.Section, each.id)} "${each.name}" is revived.`);
      return { outcome: "done", message: [`Restored ${rowId}.`, ...notices].join(" "), row: rowToContract(restored) };
    }, numberOfShortId(IdPrefix.Row, rowId));
  }

  async archiveSection(sectionId: string, request: WriterRequest): Promise<WriteResponse> {
    return this.write((queries, now) => {
      const section = this.sectionOf(queries, sectionId);
      if (section === undefined) return refused(`There is no section ${sectionId}.`);
      if (section.archivedAt !== null) return { outcome: "done", message: `Section ${sectionId} was already archived.`, section: sectionToContract(section) };
      archiveSectionWithItsRows(queries, now, request.writer, section);
      return { outcome: "done", message: `Archived section ${sectionId} with its rows.`, section: sectionToContract(this.sectionOf(queries, sectionId)!) };
    });
  }

  async restoreSection(sectionId: string, request: WriterRequest): Promise<WriteResponse> {
    return this.write((queries, now) => {
      const section = this.sectionOf(queries, sectionId);
      if (section === undefined) return refused(`There is no section ${sectionId}.`);
      if (section.archivedAt === null) return { outcome: "done", message: `Section ${sectionId} is already live.`, section: sectionToContract(section) };
      restoreSectionWithItsRows(queries, now, request.writer, section);
      return { outcome: "done", message: `Restored section ${sectionId} with the rows that were live when it was archived.`, section: sectionToContract(this.sectionOf(queries, sectionId)!) };
    });
  }

  async createTab(request: CreateTabRequest): Promise<WriteResponse> {
    return this.write((queries, now) => {
      const staleToken = this.refusalIfTokenIsStale(queries, request.listingToken);
      if (staleToken !== undefined) return staleToken;
      const tabs = queries.select().from(tabTable).all();
      const namesake = tabs.find((tab) => sameName(tab.name, request.name));
      if (namesake !== undefined && namesake.archivedAt === null) {
        return refused(`A tab named "${namesake.name}" already exists as ${shortId(IdPrefix.Tab, namesake.id)}.`, { tab: tabToContract(namesake) });
      }
      if (namesake !== undefined) {
        const revived = queries.update(tabTable).set({ archivedAt: null, archivedBy: null, changedAt: now, changedBy: request.writer }).where(eq(tabTable.id, namesake.id)).returning().get();
        writeJournal(queries, now, { writer: request.writer, action: "revive", item: shortId(IdPrefix.Tab, namesake.id), before: namesake, after: revived });
        return { outcome: "done", message: `The archived tab "${revived.name}" (${shortId(IdPrefix.Tab, revived.id)}) is revived instead of a second one.`, tab: tabToContract(revived) };
      }
      const position = Math.max(-1, ...tabs.map((tab) => tab.position)) + 1;
      const created = queries
        .insert(tabTable)
        .values({ name: request.name.trim(), position, writtenAt: now, writtenBy: request.writer, changedAt: now, changedBy: request.writer })
        .returning()
        .get();
      writeJournal(queries, now, { writer: request.writer, action: "create", item: shortId(IdPrefix.Tab, created.id), after: created });
      return { outcome: "done", message: `Created tab ${shortId(IdPrefix.Tab, created.id)} "${created.name}".`, tab: tabToContract(created) };
    });
  }

  async createSection(request: CreateSectionRequest): Promise<WriteResponse> {
    return this.write((queries, now) => {
      const staleToken = this.refusalIfTokenIsStale(queries, request.listingToken);
      if (staleToken !== undefined) return staleToken;
      const tabId = numberOfShortId(IdPrefix.Tab, request.tabId);
      const tab = tabId === undefined ? undefined : queries.select().from(tabTable).where(eq(tabTable.id, tabId)).get();
      if (tab === undefined) return refused(`There is no tab ${request.tabId}.`, { listing: readListing(queries) });
      const parent = request.parentId === undefined ? undefined : this.sectionOf(queries, request.parentId);
      if (request.parentId !== undefined && (parent === undefined || parent.tabId !== tab.id)) {
        return refused(`There is no section ${request.parentId} in tab ${request.tabId}.`, { listing: readListing(queries) });
      }
      const parentId = parent?.id ?? null;
      const siblings = queries
        .select()
        .from(sectionTable)
        .where(and(eq(sectionTable.tabId, tab.id), parentId === null ? isNull(sectionTable.parentId) : eq(sectionTable.parentId, parentId)))
        .all();
      const namesake = siblings.find((sibling) => sameName(sibling.name, request.name));
      if (namesake !== undefined && namesake.archivedAt === null) {
        return refused(`A section named "${namesake.name}" already exists here as ${shortId(IdPrefix.Section, namesake.id)}.`, { section: sectionToContract(namesake) });
      }
      const notices = (parent === undefined ? [] : reviveSectionAndItsParents(queries, now, request.writer, parent)).map(revivedSectionNotice);
      if (namesake !== undefined) {
        reviveSectionAndItsParents(queries, now, request.writer, namesake);
        const revived = this.sectionOf(queries, shortId(IdPrefix.Section, namesake.id))!;
        return {
          outcome: "done",
          message: [...notices, `The archived section "${revived.name}" (${shortId(IdPrefix.Section, revived.id)}) is revived instead of a second one; its archived rows stay archived.`].join(" "),
          section: sectionToContract(revived),
        };
      }
      const created = queries
        .insert(sectionTable)
        .values({
          tabId: tab.id,
          parentId,
          name: request.name.trim(),
          position: nextSectionPosition(queries, tab.id, parentId),
          writtenAt: now,
          writtenBy: request.writer,
          changedAt: now,
          changedBy: request.writer,
        })
        .returning()
        .get();
      writeJournal(queries, now, { writer: request.writer, action: "create", item: shortId(IdPrefix.Section, created.id), after: created });
      return { outcome: "done", message: [...notices, `Created section ${shortId(IdPrefix.Section, created.id)} "${created.name}".`].join(" "), section: sectionToContract(created) };
    });
  }

  async purge(request: PurgeRequest): Promise<PurgeResponse> {
    const database = await this.database();
    const now = this.clock();
    const purged = database.transaction((transaction) => purgeArchived(transaction, now, request.dryRun, request.writer));
    const verb = request.dryRun ? "would delete" : "deleted";
    return { outcome: "done", message: `The purge ${verb} ${purged.length} archived item(s).`, purged };
  }

  private async purgeOnTheMinute(): Promise<void> {
    try {
      await this.purge({ dryRun: false, writer: HOUSEKEEPING_WRITER });
    } catch (error) {
      console.error(`[where-i-stand] the minute purge failed: ${String(error)}`);
    }
  }

  onModuleInit(): void {
    this.purgeTimer = setInterval(() => void this.purgeOnTheMinute(), PURGE_EVERY_MS);
    this.purgeTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.purgeTimer !== undefined) clearInterval(this.purgeTimer);
    const opened = this.opened;
    this.opened = undefined;
    if (opened !== undefined) (await opened).close();
  }
}
