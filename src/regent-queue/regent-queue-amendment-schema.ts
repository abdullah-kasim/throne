import type { DatabaseSync } from "node:sqlite";

export function createRegentQueueAmendmentSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_amendments (
      queue_item_id TEXT NOT NULL,
      objective_code TEXT NOT NULL,
      amendment_number INTEGER NOT NULL,
      amendment_text TEXT NOT NULL,
      words_of TEXT NOT NULL,
      relayed_by TEXT NOT NULL,
      row_status_when_recorded TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (queue_item_id, amendment_number)
    )
  `);
}
