import { DatabaseSync } from "node:sqlite";

/**
 * Creates (or upgrades) the `queue_items` table and its indexes on an
 * already-opened `DatabaseSync` handle. Idempotent — every statement is
 * `CREATE ... IF NOT EXISTS` — so calling it against an existing database is
 * a no-op upgrade path, never a data loss risk. Its reason to change is
 * schema evolution, distinct from `RegentQueueStore`'s CRUD reason to
 * change; `openRegentQueueStore` composes it before constructing the store.
 */
export function createRegentQueueSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_items (
      id TEXT PRIMARY KEY,
      objective_code TEXT,
      status TEXT NOT NULL,
      body TEXT NOT NULL,
      launch_eligible INTEGER NOT NULL DEFAULT 0,
      launch_alpha_name TEXT,
      launch_target_repo TEXT,
      launch_target_branch TEXT,
      launch_base_commit TEXT,
      pr_branch TEXT,
      model_hint_harness TEXT,
      model_hint_model TEXT,
      deliverable_shape TEXT,
      agent_name TEXT,
      target_repo TEXT,
      base_commit TEXT,
      delivery_commit TEXT,
      validation_required INTEGER NOT NULL DEFAULT 0,
      validation_required_at INTEGER,
      delivery_mirror_state TEXT NOT NULL DEFAULT 'unknown',
      delivery_mirror_commit TEXT,
      delivery_mirror_repo TEXT,
      delivery_mirror_branch TEXT,
      delivery_mirror_tree_identity TEXT,
      delivery_mirror_checked_at INTEGER,
      delivery_mirror_reason TEXT,
      absorption_objective_code TEXT,
      absorption_delivery_commit TEXT,
      absorption_target_repo TEXT,
      absorption_target_branch TEXT,
      absorption_tree_identity TEXT,
      absorption_checked_at INTEGER,
      absorption_reason TEXT,
      deferred_depends_on TEXT,
      deferred_release_authority TEXT,
      deferred_reason TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const columns = db.prepare(`PRAGMA table_info(queue_items)`).all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("launch_eligible"))
    db.exec(
      `ALTER TABLE queue_items ADD COLUMN launch_eligible INTEGER NOT NULL DEFAULT 0`,
    );
  if (!names.has("launch_alpha_name"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN launch_alpha_name TEXT`);
  if (!names.has("launch_target_repo"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN launch_target_repo TEXT`);
  if (!names.has("launch_target_branch"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN launch_target_branch TEXT`);
  if (!names.has("launch_base_commit"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN launch_base_commit TEXT`);
  if (!names.has("pr_branch"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN pr_branch TEXT`);
  // Deferral fields, added 2026-08-25 with the `deferred` status. A held row
  // used to be spelled `in-flight` with no agent, because "deferred" could not
  // be expressed; that made "an Alpha has this" and "nobody may touch this"
  // the same state, and a hold whose condition had cleared never released
  // itself. See `regent-queue-item-state.ts`.
  if (!names.has("deferred_depends_on"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN deferred_depends_on TEXT`);
  if (!names.has("deferred_release_authority"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN deferred_release_authority TEXT`);
  if (!names.has("deferred_reason"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN deferred_reason TEXT`);
  if (!names.has("model_hint_harness"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN model_hint_harness TEXT`);
  if (!names.has("model_hint_model"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN model_hint_model TEXT`);
  if (!names.has("deliverable_shape"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN deliverable_shape TEXT`);
  if (!names.has("delivery_mirror_state"))
    db.exec(
      `ALTER TABLE queue_items ADD COLUMN delivery_mirror_state TEXT NOT NULL DEFAULT 'unknown'`,
    );
  if (!names.has("delivery_mirror_commit"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN delivery_mirror_commit TEXT`);
  if (!names.has("delivery_mirror_repo"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN delivery_mirror_repo TEXT`);
  if (!names.has("delivery_mirror_branch"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN delivery_mirror_branch TEXT`);
  if (!names.has("delivery_mirror_tree_identity"))
    db.exec(
      `ALTER TABLE queue_items ADD COLUMN delivery_mirror_tree_identity TEXT`,
    );
  if (!names.has("delivery_mirror_checked_at"))
    db.exec(
      `ALTER TABLE queue_items ADD COLUMN delivery_mirror_checked_at INTEGER`,
    );
  if (!names.has("delivery_mirror_reason"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN delivery_mirror_reason TEXT`);
  if (!names.has("absorption_objective_code"))
    db.exec(
      `ALTER TABLE queue_items ADD COLUMN absorption_objective_code TEXT`,
    );
  if (!names.has("absorption_delivery_commit"))
    db.exec(
      `ALTER TABLE queue_items ADD COLUMN absorption_delivery_commit TEXT`,
    );
  if (!names.has("absorption_target_repo"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN absorption_target_repo TEXT`);
  if (!names.has("absorption_target_branch"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN absorption_target_branch TEXT`);
  if (!names.has("absorption_tree_identity"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN absorption_tree_identity TEXT`);
  if (!names.has("absorption_checked_at"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN absorption_checked_at INTEGER`);
  if (!names.has("absorption_reason"))
    db.exec(`ALTER TABLE queue_items ADD COLUMN absorption_reason TEXT`);
  if (!names.has("priority"))
    db.exec(
      `ALTER TABLE queue_items ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`,
    );
  if (!names.has("validation_required"))
    db.exec(
      `ALTER TABLE queue_items ADD COLUMN validation_required INTEGER NOT NULL DEFAULT 0`,
    );
  if (!names.has("validation_required_at"))
    db.exec(
      `ALTER TABLE queue_items ADD COLUMN validation_required_at INTEGER`,
    );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_queue_items_status
      ON queue_items (status)
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_items_objective_code
      ON queue_items (objective_code)
      WHERE objective_code IS NOT NULL
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_launch_briefs (
      queue_item_id TEXT PRIMARY KEY REFERENCES queue_items(id),
      canonical_name TEXT NOT NULL,
      target_repo TEXT NOT NULL,
      target_branch TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      authorizer TEXT NOT NULL,
      briefed_at INTEGER NOT NULL,
      lifecycle TEXT NOT NULL,
      expired_at INTEGER,
      pr_branch TEXT
    )
  `);
  const briefColumns = db
    .prepare(`PRAGMA table_info(queue_launch_briefs)`)
    .all() as Array<{ name: string }>;
  const briefNames = new Set(briefColumns.map((column) => column.name));
  if (!briefNames.has("pr_branch"))
    db.exec(`ALTER TABLE queue_launch_briefs ADD COLUMN pr_branch TEXT`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_item_archive (
      archive_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      objective_code TEXT,
      status TEXT NOT NULL,
      body TEXT NOT NULL,
      launch_eligible INTEGER NOT NULL,
      launch_alpha_name TEXT,
      launch_target_repo TEXT,
      launch_target_branch TEXT,
      launch_base_commit TEXT,
      pr_branch TEXT,
      agent_name TEXT,
      target_repo TEXT,
      base_commit TEXT,
      delivery_commit TEXT,
      validation_required INTEGER NOT NULL DEFAULT 0,
      validation_required_at INTEGER,
      delivery_mirror_state TEXT NOT NULL DEFAULT 'unknown',
      delivery_mirror_commit TEXT,
      delivery_mirror_repo TEXT,
      delivery_mirror_branch TEXT,
      delivery_mirror_tree_identity TEXT,
      delivery_mirror_checked_at INTEGER,
      delivery_mirror_reason TEXT,
      absorption_objective_code TEXT,
      absorption_delivery_commit TEXT,
      absorption_target_repo TEXT,
      absorption_target_branch TEXT,
      absorption_tree_identity TEXT,
      absorption_checked_at INTEGER,
      absorption_reason TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      predicate TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS queue_mutation_audit (
      operation_id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      predicate TEXT NOT NULL,
      operated_at INTEGER NOT NULL,
      row_count INTEGER NOT NULL
    );
  `);
  const archiveColumns = db
    .prepare(`PRAGMA table_info(queue_item_archive)`)
    .all() as Array<{ name: string }>;
  const archiveNames = new Set(archiveColumns.map((column) => column.name));
  if (!archiveNames.has("pr_branch"))
    db.exec(`ALTER TABLE queue_item_archive ADD COLUMN pr_branch TEXT`);
  if (!archiveNames.has("delivery_mirror_state"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN delivery_mirror_state TEXT NOT NULL DEFAULT 'unknown'`,
    );
  if (!archiveNames.has("delivery_mirror_commit"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN delivery_mirror_commit TEXT`,
    );
  if (!archiveNames.has("delivery_mirror_repo"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN delivery_mirror_repo TEXT`,
    );
  if (!archiveNames.has("delivery_mirror_branch"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN delivery_mirror_branch TEXT`,
    );
  if (!archiveNames.has("delivery_mirror_tree_identity"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN delivery_mirror_tree_identity TEXT`,
    );
  if (!archiveNames.has("delivery_mirror_checked_at"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN delivery_mirror_checked_at INTEGER`,
    );
  if (!archiveNames.has("delivery_mirror_reason"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN delivery_mirror_reason TEXT`,
    );
  if (!archiveNames.has("absorption_objective_code"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN absorption_objective_code TEXT`,
    );
  if (!archiveNames.has("absorption_delivery_commit"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN absorption_delivery_commit TEXT`,
    );
  if (!archiveNames.has("absorption_target_repo"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN absorption_target_repo TEXT`,
    );
  if (!archiveNames.has("absorption_target_branch"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN absorption_target_branch TEXT`,
    );
  if (!archiveNames.has("absorption_tree_identity"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN absorption_tree_identity TEXT`,
    );
  if (!archiveNames.has("absorption_checked_at"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN absorption_checked_at INTEGER`,
    );
  if (!archiveNames.has("absorption_reason"))
    db.exec(`ALTER TABLE queue_item_archive ADD COLUMN absorption_reason TEXT`);
  if (!archiveNames.has("priority"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`,
    );
  if (!archiveNames.has("validation_required"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN validation_required INTEGER NOT NULL DEFAULT 0`,
    );
  if (!archiveNames.has("validation_required_at"))
    db.exec(
      `ALTER TABLE queue_item_archive ADD COLUMN validation_required_at INTEGER`,
    );
}
