import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const locks = sqliteTable("locks", {
  name: text("name").primaryKey(),
  holderProcessId: integer("holder_process_id").notNull(),
  holderStartedAt: integer("holder_started_at"),
  takenAt: integer("taken_at").notNull(),
  commandProcessId: integer("command_process_id"),
  commandStartedAt: integer("command_started_at"),
  commandLine: text("command_line"),
});
