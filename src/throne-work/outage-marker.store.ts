import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { resolveMessageQueueDatabasePath } from "../message-queue/message-queue.store.ts";

/** The durable outage-marker read/write surface, for injecting a fake in tests. */
export interface OutageMarker {
  isActive(): boolean;
  setActive(setAt: number): void;
  clear(): void;
  close(): void;
}

/**
 * The durable "we already told the Lord about this outage" flag. Lives in
 * its own table on the same durable queue database file (own connection,
 * own schema) rather than inside `MessageQueueStore` — a deliberate
 * separate concern: the queue's own read/write surface is a locked slice-01
 * contract this slice does not extend, and the marker is a work-processor
 * liveness decision, not a work-item state.
 */
export class OutageMarkerStore implements OutageMarker {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  isActive(): boolean {
    const row = this.db
      .prepare(`SELECT active FROM sustained_outage_marker WHERE id = 1`)
      .get() as unknown as { active: number } | undefined;
    return row !== undefined && row.active === 1;
  }

  setActive(setAt: number): void {
    this.db
      .prepare(
        `INSERT INTO sustained_outage_marker (id, active, set_at) VALUES (1, 1, ?)
         ON CONFLICT (id) DO UPDATE SET active = 1, set_at = excluded.set_at`,
      )
      .run(setAt);
  }

  clear(): void {
    this.db
      .prepare(
        `INSERT INTO sustained_outage_marker (id, active, set_at) VALUES (1, 0, 0)
         ON CONFLICT (id) DO UPDATE SET active = 0`,
      )
      .run();
  }

  close(): void {
    this.db.close();
  }
}

export function openOutageMarkerStore(
  databasePath: string = resolveMessageQueueDatabasePath(),
): OutageMarker {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sustained_outage_marker (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active INTEGER NOT NULL,
      set_at INTEGER NOT NULL
    )
  `);
  return new OutageMarkerStore(db);
}
