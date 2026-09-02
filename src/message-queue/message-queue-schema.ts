import { DatabaseSync } from "node:sqlite";

/**
 * `work_items.kind` is not load-bearing for the current delivery contract:
 * every historical and current row is `message-delivery`, so no behavior
 * selects among work types today. It remains an established schema
 * discriminator, including in the dedupe index, so future work types can be
 * additive without renaming `work_items` or `kind`; dependent sqd, sqs, and
 * sqx consumers require both established names to remain unchanged.
 *
 * Creates (or upgrades) the `work_items`/`server_heartbeat`/
 * `retention_sweep_runs` tables and their indexes on an already-opened
 * `DatabaseSync` handle. `work_items` is the message-delivery queue table;
 * `queue_items` separately names the Regent's objective queue, so the
 * similarly named tables retain their distinct established roles. Idempotent
 * — every statement is `CREATE ... IF NOT EXISTS` or an add-column-if-missing
 * migration — so calling it against an existing database is a no-op upgrade
 * path, never a data loss risk. Its reason to change is schema evolution,
 * distinct from `MessageQueueStore`'s CRUD reason to change;
 * `openMessageQueueStore` composes it with the delivery-failure-notice schema
 * before constructing the store.
 */
export function createMessageQueueSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      state TEXT NOT NULL,
      failure_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  addAttemptCountColumnIfMissing(db);
  addMaximumAttemptsColumnIfMissing(db);
  addTerminalAtColumnIfMissing(db);
  backfillMissingTerminalAt(db);
  addDedupeKeyColumnIfMissing(db);
  addDueAtColumnIfMissing(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_items_state_created_at
      ON work_items (state, created_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_items_kind_dedupe_key
      ON work_items (kind, dedupe_key)
      WHERE dedupe_key IS NOT NULL
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_items_queued_due_at
      ON work_items (due_at, created_at)
      WHERE state = 'queued'
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_items_terminal_at
      ON work_items (terminal_at)
      WHERE terminal_at IS NOT NULL
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_heartbeat (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS retention_sweep_runs (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      swept_count INTEGER NOT NULL,
      swept_at INTEGER NOT NULL
    )
  `);
}

/**
 * `CREATE TABLE IF NOT EXISTS` alone can't add a column to a `work_items`
 * table that already existed before retention shipped, so this checks
 * `PRAGMA table_info` and runs the one-time `ALTER TABLE ADD COLUMN` only
 * when `terminal_at` is actually missing — idempotent either way, same as
 * every other schema statement here.
 */
function addTerminalAtColumnIfMissing(db: DatabaseSync): void {
  const columns = db
    .prepare(`PRAGMA table_info(work_items)`)
    .all() as unknown as Array<{
    name: string;
  }>;
  const hasTerminalAt = columns.some((column) => column.name === "terminal_at");
  if (!hasTerminalAt) {
    db.exec(`ALTER TABLE work_items ADD COLUMN terminal_at INTEGER`);
  }
}

/**
 * A terminal row (`delivered`/`failed`) with `terminal_at IS NULL` is
 * structurally exempt from `sweepExpiredTerminalWorkItems`'s
 * `terminal_at IS NOT NULL` predicate forever, since nothing ever
 * transitions it again to set the column — a row can only get here by
 * having reached its terminal state before this column existed (the
 * `ADD COLUMN` above defaults new rows' existing terminal state to NULL;
 * every write since correctly sets it). Run on every store open, not just
 * when the column is freshly added, so it self-heals a database that
 * already carried the column with these rows already NULL — as the live
 * one does (Regent finding, 2026-08-14, campaign qfr: 20 `failed` rows from
 * 2026-08-10, four days old, sat immortal this way while 17 newer `failed`
 * rows aged out of the 2-day window right on schedule). `WHERE terminal_at
 * IS NULL` makes every run after the first a no-op UPDATE.
 */
function backfillMissingTerminalAt(db: DatabaseSync): void {
  db.exec(
    `UPDATE work_items SET terminal_at = updated_at
     WHERE state IN ('delivered', 'failed') AND terminal_at IS NULL`,
  );
}

/** Same idempotent add-if-missing shape as `addTerminalAtColumnIfMissing`, for `dedupe_key`. */
function addDedupeKeyColumnIfMissing(db: DatabaseSync): void {
  const columns = db
    .prepare(`PRAGMA table_info(work_items)`)
    .all() as unknown as Array<{
    name: string;
  }>;
  const hasDedupeKey = columns.some((column) => column.name === "dedupe_key");
  if (!hasDedupeKey) {
    db.exec(`ALTER TABLE work_items ADD COLUMN dedupe_key TEXT`);
  }
}

/** Scheduled rows retain their due instant in SQLite so a restarted worker can resume them. */
function addDueAtColumnIfMissing(db: DatabaseSync): void {
  const columns = db
    .prepare(`PRAGMA table_info(work_items)`)
    .all() as unknown as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "due_at")) {
    db.exec(`ALTER TABLE work_items ADD COLUMN due_at INTEGER`);
  }
}

function addAttemptCountColumnIfMissing(db: DatabaseSync): void {
  const columns = db
    .prepare(`PRAGMA table_info(work_items)`)
    .all() as unknown as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "attempt_count")) {
    db.exec(
      `ALTER TABLE work_items ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`,
    );
  }
}

function addMaximumAttemptsColumnIfMissing(db: DatabaseSync): void {
  const columns = db
    .prepare(`PRAGMA table_info(work_items)`)
    .all() as unknown as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "maximum_attempts")) {
    db.exec(
      `ALTER TABLE work_items ADD COLUMN maximum_attempts INTEGER NOT NULL DEFAULT 1`,
    );
  }
}
