import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";
import { createRegentQueueSchema } from "./regent-queue-schema.ts";

export const REGENT_QUEUE_DATABASE_FILE_NAME = "regent-queue.sqlite3";

export function resolveRegentQueueDatabasePath(
  dataDir: string = RUNTIME_DATA_DIR,
): string {
  return path.join(dataDir, REGENT_QUEUE_DATABASE_FILE_NAME);
}

export function openRegentQueueDatabase(databasePath: string): DatabaseSync {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  createRegentQueueSchema(db);
  return db;
}
