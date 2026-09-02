import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RUNTIME_DATA_HOME_ENV, resolveRuntimeDataHome } from "../src/shared-policy/runtime-data-home.ts";
import {
  REGENT_QUEUE_DATABASE_FILE_NAME,
  resolveRegentQueueDatabasePath,
} from "../src/regent-queue/regent-queue-database.ts";
import { MESSAGE_QUEUE_DATABASE_FILE_NAME, resolveMessageQueueDatabasePath } from "../src/message-queue/message-queue.store.ts";

const SCRATCH_STATE_PREFIX = "throne-scratch-state-";

export interface ScratchThroneState {
  readonly dataHome: string;
  readonly dataDir: string;
  readonly environment: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

export interface QueueRowCounts {
  readonly regent: number;
  readonly message: number;
}

export async function createScratchThroneState(): Promise<ScratchThroneState> {
  const scratchRoot = path.join(os.homedir(), "tmp");
  await mkdir(scratchRoot, { recursive: true });
  const dataHome = await mkdtemp(path.join(scratchRoot, SCRATCH_STATE_PREFIX));
  const dataDir = path.join(dataHome, "data");
  const environment = { ...process.env, [RUNTIME_DATA_HOME_ENV]: dataHome };

  return {
    dataHome,
    dataDir,
    environment,
    cleanup: () => rm(dataHome, { recursive: true, force: true }),
  };
}

export function readAmbientQueueRowCounts(): QueueRowCounts {
  const dataHome = resolveRuntimeDataHome();
  return {
    regent: countRows(
      resolveRegentQueueDatabasePath(path.join(dataHome, "data")),
      "queue_items",
    ),
    message: countRows(resolveMessageQueueDatabasePath(dataHome), "work_items"),
  };
}

export function scratchQueuePaths(state: ScratchThroneState): {
  readonly regent: string;
  readonly message: string;
} {
  return {
    regent: resolveRegentQueueDatabasePath(state.dataDir),
    message: resolveMessageQueueDatabasePath(state.dataHome),
  };
}

export function scratchStateDatabaseNames(): readonly string[] {
  return [REGENT_QUEUE_DATABASE_FILE_NAME, MESSAGE_QUEUE_DATABASE_FILE_NAME];
}

function countRows(databasePath: string, tableName: string): number {
  if (!existsSync(databasePath)) return 0;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count);
  } finally {
    database.close();
  }
}
