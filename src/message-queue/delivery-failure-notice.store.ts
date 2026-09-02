import { DatabaseSync } from "node:sqlite";

/**
 * The only shape `recordDeliveryFailureNotice` needs from a work item —
 * declared locally rather than imported from `message-queue.store.ts` so
 * that file (the importer here) and this one never form an import cycle.
 */
interface FailedWorkItemAttribution {
  readonly id: number;
  readonly payload: unknown;
  readonly failureReason: string | null;
}

/**
 * A durable receipt that a work item terminalised as `failed` — the
 * closed-loop delivery-reporting record. Written once, synchronously, in
 * the same transition that terminal-fails the item, so it cannot be lost
 * the way the underlying send already was: either the failing transition
 * commits with its notice or neither commits. Never written for
 * `delivered` (789-of-831 must stay silent) or for the dedupe-supersede
 * path (an expected, sender-caused replacement, not a delivery defect).
 * Split out of `message-queue.store.ts` to keep that file under the
 * repository's file-size boundary — `MessageQueueStore`'s own methods stay
 * thin delegators onto the functions here.
 */
export interface DeliveryFailureNoticeRow {
  readonly id: number;
  readonly workItemId: number;
  readonly senderName: string;
  readonly recipientName: string | null;
  readonly failureReason: string;
  readonly createdAt: number;
  readonly acknowledgedAt: number | null;
}

interface DeliveryFailureNoticeSqlRow {
  id: number;
  work_item_id: number;
  sender_name: string;
  recipient_name: string | null;
  failure_reason: string;
  created_at: number;
  acknowledged_at: number | null;
}

function toDeliveryFailureNoticeRow(
  row: DeliveryFailureNoticeSqlRow,
): DeliveryFailureNoticeRow {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    senderName: row.sender_name,
    recipientName: row.recipient_name,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

/**
 * Best-effort, non-throwing extraction of `senderName`/`recipientName` from
 * a work item's opaque `payload`. Every registered work kind's payload is a
 * plain object; a kind that carries no `senderName` (or a malformed one)
 * simply gets no notice rather than a crash — attribution is additive, never
 * a new way for the state machine itself to fail.
 */
function extractSenderAndRecipient(
  payload: unknown,
): { senderName: string; recipientName: string | null } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const senderName = record.senderName;
  if (typeof senderName !== "string" || senderName.length === 0) return undefined;
  const recipientName =
    typeof record.recipientName === "string" ? record.recipientName : null;
  return { senderName, recipientName };
}

/** Idempotent schema creation, called once from `openMessageQueueStore`. */
export function createDeliveryFailureNoticeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_failure_notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER NOT NULL,
      sender_name TEXT NOT NULL,
      recipient_name TEXT,
      failure_reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_delivery_failure_notices_sender_unacked
      ON delivery_failure_notices (sender_name, acknowledged_at)
  `);
}

/**
 * The one write site for closed-loop delivery reporting. Called from inside
 * `MessageQueueStore.transitionWorkItemState` itself — the single choke
 * point every terminal-fail path (the handler's own terminal-fail, startup
 * orphan reclaim) runs through — so no caller can add a new failure path
 * that forgets to notify. The dedupe-supersede path writes `failed` with
 * raw SQL and never reaches here by construction, which is correct: a
 * superseded queued row is the sender's own newer send replacing it, not a
 * defect to report. Silently skips attribution it cannot make rather than
 * failing the transition itself.
 */
export function recordDeliveryFailureNotice(
  db: DatabaseSync,
  item: FailedWorkItemAttribution,
  timestamp: number,
): void {
  const attribution = extractSenderAndRecipient(item.payload);
  if (attribution === undefined) return;
  db.prepare(
    `INSERT INTO delivery_failure_notices
       (work_item_id, sender_name, recipient_name, failure_reason, created_at, acknowledged_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(item.id, attribution.senderName, attribution.recipientName, item.failureReason ?? "", timestamp);
}

/**
 * `recordDeliveryFailureNotice`, but a second fault writing the notice can
 * never propagate: the delivery outcome the caller already committed is
 * the truth, this notice is a convenience on top of it, and this call runs
 * exactly on the failure path — the moment the system is already under
 * stress. Caught and logged to stderr, never rethrown, so a notice-write
 * fault degrades to "this one notice was lost" instead of taking the
 * state machine (and, upstream, the whole dispatch loop) down with it.
 */
export function recordDeliveryFailureNoticeSafely(
  db: DatabaseSync,
  item: FailedWorkItemAttribution,
  timestamp: number,
): void {
  try {
    recordDeliveryFailureNotice(db, item, timestamp);
  } catch (error) {
    process.stderr.write(
      `throne-work: delivery-failure notice write failed for work item ${item.id}, ` +
        `continuing (the item's own terminal state is unaffected): ${
          error instanceof Error ? error.message : String(error)
        }\n`,
    );
  }
}

/**
 * Every unacknowledged delivery-failure notice addressed to `senderName`,
 * oldest first — the sender's poll surface. Read-only: nothing here marks a
 * notice acknowledged, so a crash between reading and acting on the result
 * never loses it.
 */
export function listUnacknowledgedDeliveryFailureNotices(
  db: DatabaseSync,
  senderName: string,
): DeliveryFailureNoticeRow[] {
  const rows = db
    .prepare(
      `SELECT id, work_item_id, sender_name, recipient_name, failure_reason, created_at, acknowledged_at
       FROM delivery_failure_notices
       WHERE sender_name = ? AND acknowledged_at IS NULL
       ORDER BY created_at ASC`,
    )
    .all(senderName) as unknown as DeliveryFailureNoticeSqlRow[];
  return rows.map(toDeliveryFailureNoticeRow);
}

/**
 * Total unacknowledged notices across every sender — the status report's
 * observability seam. Deliberately sender-blind (unlike
 * `listUnacknowledgedDeliveryFailureNotices`): a status reader needs to know
 * "does anything need review" before it needs to know who to attribute it
 * to, and a per-sender poll surface with no caller that ever sweeps it is
 * exactly how 18 real notices sat unread for days (Regent finding,
 * 2026-08-14, campaign qfr).
 */
export function countAllUnacknowledgedDeliveryFailureNotices(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM delivery_failure_notices WHERE acknowledged_at IS NULL`)
    .get() as unknown as { c: number };
  return row.c;
}

/**
 * Marks one notice acknowledged — a deliberate act by (or on behalf of) its
 * sender, never automatic, so merely reading the notice can't make it
 * disappear before the sender has actually decided what to do about it.
 */
export function acknowledgeDeliveryFailureNotice(
  db: DatabaseSync,
  id: number,
  now: number,
): DeliveryFailureNoticeRow | undefined {
  const row = db
    .prepare(
      `UPDATE delivery_failure_notices SET acknowledged_at = ?
       WHERE id = ? AND acknowledged_at IS NULL
       RETURNING id, work_item_id, sender_name, recipient_name, failure_reason, created_at, acknowledged_at`,
    )
    .get(now, id) as unknown as DeliveryFailureNoticeSqlRow | undefined;
  return row === undefined ? undefined : toDeliveryFailureNoticeRow(row);
}
