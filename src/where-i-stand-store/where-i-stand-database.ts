import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";

export const WHERE_I_STAND_DATABASE_FILE_NAME = "where-i-stand.sqlite3";

export const COMMITTED_MIGRATIONS_DIRECTORY = path.join(RUNTIME_THRONE_ROOT, "drizzle");

const WAIT_FOR_ANOTHER_WRITER_MS = 5000;

const SETUP_ATTEMPTS = 20;

const SETUP_RETRY_INTERVAL_MS = 25;

export type WhereIStandDatabaseHandle = BetterSQLite3Database;

export interface WhereIStandDatabase {
  database: WhereIStandDatabaseHandle;
  close: () => void;
}

export function whereIStandDatabasePath(throneHome: string): string {
  return path.join(throneHome, WHERE_I_STAND_DATABASE_FILE_NAME);
}

export async function openWhereIStandDatabase(
  throneHome: string,
  migrationsDirectory: string = COMMITTED_MIGRATIONS_DIRECTORY,
): Promise<WhereIStandDatabase> {
  return openMigratedDatabase(whereIStandDatabasePath(throneHome), migrationsDirectory);
}

export function openMigratedDatabase(databasePath: string, migrationsDirectory: string): WhereIStandDatabase {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const connection = new Database(databasePath);
  connection.pragma(`busy_timeout = ${WAIT_FOR_ANOTHER_WRITER_MS}`);
  retryWhileAnotherProcessSetsUp(() => connection.pragma("journal_mode = WAL"));
  connection.pragma("foreign_keys = ON");
  const database = drizzle(connection);
  try {
    retryWhileAnotherProcessSetsUp(() => migrate(database, { migrationsFolder: migrationsDirectory }));
  } catch (error) {
    connection.close();
    throw new Error(`could not apply the migrations in ${migrationsDirectory}: ${String(error)}`, { cause: error });
  }
  return { database, close: () => connection.close() };
}

function retryWhileAnotherProcessSetsUp(step: () => unknown): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      step();
      return;
    } catch (error) {
      if (attempt === SETUP_ATTEMPTS) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SETUP_RETRY_INTERVAL_MS);
    }
  }
}
