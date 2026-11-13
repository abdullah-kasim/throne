import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const ContentKind = {
  Work: "work",
  Event: "event",
  Epic: "epic",
} as const;

export type ContentKind = (typeof ContentKind)[keyof typeof ContentKind];

const timeColumn = (name: string) => integer(name, { mode: "timestamp_ms" });

const authorship = {
  writtenAt: timeColumn("written_at").notNull(),
  writtenBy: text("written_by").notNull(),
  changedAt: timeColumn("changed_at").notNull(),
  changedBy: text("changed_by").notNull(),
  archivedAt: timeColumn("archived_at"),
  archivedBy: text("archived_by"),
};

export const tabTable = sqliteTable("tab", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  position: integer("position").notNull(),
  ...authorship,
});

export const sectionTable = sqliteTable(
  "section",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tabId: integer("tab_id")
      .notNull()
      .references(() => tabTable.id),
    parentId: integer("parent_id").references((): AnySQLiteColumn => sectionTable.id),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    ...authorship,
  },
  (section) => [index("section_tab").on(section.tabId)],
);

export const contentTable = sqliteTable(
  "content",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sectionId: integer("section_id")
      .notNull()
      .references(() => sectionTable.id),
    kind: text("kind", { enum: [ContentKind.Work, ContentKind.Event, ContentKind.Epic] }).notNull(),
    code: text("code"),
    links: text("links"),
    workKind: text("work_kind"),
    whereItStands: text("where_it_stands"),
    freeLines: text("free_lines").notNull().default(""),
    text: text("text").notNull().default(""),
    writtenDateIsEstimate: integer("written_date_is_estimate", { mode: "boolean" }).notNull().default(false),
    position: integer("position").notNull().default(0),
    ...authorship,
  },
  (content) => [
    index("content_section").on(content.sectionId),
    uniqueIndex("one_live_work_row_per_code")
      .on(content.code)
      .where(sql`${content.kind} = 'work' and ${content.archivedAt} is null`),
  ],
);

export const journalTable = sqliteTable("journal", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: timeColumn("at").notNull(),
  writer: text("writer").notNull(),
  action: text("action").notNull(),
  item: text("item").notNull(),
  before: text("before"),
  after: text("after"),
});

export type TabRow = typeof tabTable.$inferSelect;
export type SectionRow = typeof sectionTable.$inferSelect;
export type ContentRow = typeof contentTable.$inferSelect;
export type JournalRow = typeof journalTable.$inferSelect;
