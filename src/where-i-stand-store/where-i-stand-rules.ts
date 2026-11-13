import { createHash } from "node:crypto";
import { isNotNull, isNull } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { WhereIStandDatabaseHandle } from "./where-i-stand-database.ts";
import { journalTable, type SectionRow, type TabRow } from "./where-i-stand.schema.ts";

export const HOUSEKEEPING_WRITER = "throne";
export const LIVE_EVENT_LINES = 15;
export const DELIVERED_TAB_NAME = "Delivered";
export const DELIVERED_ROWS_KEPT = 20;
export const DELIVERED_DAYS_KEPT = 3;
export const MONTHS_ARCHIVED_ROWS_ARE_KEPT = 6;
const LISTING_TOKEN_LENGTH = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

export type WriteScope = Parameters<Parameters<WhereIStandDatabaseHandle["transaction"]>[0]>[0];
export type Queries = WhereIStandDatabaseHandle | WriteScope;

export function isLive(table: { archivedAt: SQLiteColumn }) {
  return isNull(table.archivedAt);
}

export function isArchived(table: { archivedAt: SQLiteColumn }) {
  return isNotNull(table.archivedAt);
}

export function sameName(first: string, second: string): boolean {
  return first.trim().toLowerCase() === second.trim().toLowerCase();
}

export function listingTokenOf(tabs: readonly TabRow[], sections: readonly SectionRow[]): string {
  const structure = {
    tabs: tabs.map((tab) => [tab.id, tab.name, tab.archivedAt === null]),
    sections: sections.map((section) => [section.id, section.tabId, section.parentId, section.name, section.archivedAt === null]),
  };
  return createHash("sha256").update(JSON.stringify(structure)).digest("hex").slice(0, LISTING_TOKEN_LENGTH);
}

export function purgeCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - MONTHS_ARCHIVED_ROWS_ARE_KEPT);
  return cutoff;
}

export function deliveredKeptSince(now: Date): Date {
  return new Date(now.getTime() - DELIVERED_DAYS_KEPT * DAY_MS);
}

export interface JournalEntry {
  readonly writer: string;
  readonly action: string;
  readonly item: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

function asJournalText(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function writeJournal(queries: Queries, at: Date, entry: JournalEntry): void {
  queries
    .insert(journalTable)
    .values({
      at,
      writer: entry.writer,
      action: entry.action,
      item: entry.item,
      before: asJournalText(entry.before),
      after: asJournalText(entry.after),
    })
    .run();
}
