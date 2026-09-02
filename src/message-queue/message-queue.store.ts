import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { RUNTIME_DATA_HOME } from "../shared-policy/runtime-data-home.ts";
import {
  acknowledgeDeliveryFailureNotice,
  countAllUnacknowledgedDeliveryFailureNotices,
  createDeliveryFailureNoticeSchema,
  listUnacknowledgedDeliveryFailureNotices,
  recordDeliveryFailureNoticeSafely,
  type DeliveryFailureNoticeRow,
} from "./delivery-failure-notice.store.ts";
export type { DeliveryFailureNoticeRow };
import {
  InvalidWorkItemStateTransitionError,
  isForwardWorkItemStateTransition,
  MessageQueueWorkItemState,
  TERMINAL_WORK_ITEM_STATES,
  WorkItemNotFoundError,
} from "./message-queue-work-item-state.ts";
export {
  InvalidWorkItemStateTransitionError,
  isForwardWorkItemStateTransition,
  MessageQueueWorkItemState,
  WorkItemNotFoundError,
};
import { createMessageQueueSchema } from "./message-queue-schema.ts";

/**
 * The queue's on-disk home: one SQLite file under the durable throne ledger
 * area (never `/tmp`), so a crashed server, a dead Regent, or a reboot never
 * loses a queued work item.
 */
export const MESSAGE_QUEUE_DATABASE_FILE_NAME = "message-queue.sqlite3";

export function resolveMessageQueueDatabasePath(
  dataHome: string = RUNTIME_DATA_HOME,
): string {
  return path.join(dataHome, MESSAGE_QUEUE_DATABASE_FILE_NAME);
}

export interface WorkItemRow {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly state: MessageQueueWorkItemState;
  readonly failureReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | null;
  readonly dueAt: number | null;
  readonly attemptCount: number;
  readonly maximumAttempts: number;
}

interface WorkItemSqlRow {
  id: number;
  kind: string;
  payload: string;
  state: string;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
  due_at: number | null;
  attempt_count: number;
  maximum_attempts: number;
}

function toWorkItemRow(row: WorkItemSqlRow): WorkItemRow {
  return {
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payload) as unknown,
    state: row.state as MessageQueueWorkItemState,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
    dueAt: row.due_at,
    attemptCount: row.attempt_count,
    maximumAttempts: row.maximum_attempts,
  };
}

/** Reason recorded on a `queued` row that a fresher same-key enqueue superseded. */
export const SUPERSEDED_FAILURE_REASON =
  "superseded by a newer enqueue with the same dedupe key";

/**
 * Messages are deleted 2 days past their TERMINAL transition, never from
 * enqueue time — a stuck `queued`/`in-flight` row is outage evidence the
 * existing heartbeat-staleness reporting must keep surfacing, not garbage
 * this sweep is allowed to touch.
 */
export const MESSAGE_RETENTION_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/** Rows removed per sweep call, so one poll tick never runs a full-table delete. */
export const MESSAGE_RETENTION_SWEEP_BATCH_SIZE = 500;

export interface RetentionSweepResult {
  readonly sweptCount: number;
  readonly sweptAt: number;
}

export interface NewWorkItem {
  readonly kind: string;
  readonly payload: unknown;
  /**
   * Optional dedupe key. Inserting a new item with the same `(kind,
   * dedupeKey)` as an existing still-`queued` row automatically supersedes
   * that older row (transitions it to `failed`) instead of leaving both
   * queued — a slow-draining queue must not stack up redundant duplicates
   * of the same logical nudge. An `in-flight` row is left alone: a delivery
   * already underway is not cancelled.
   */
  readonly dedupeKey?: string;
  /** Absent for immediate work; scheduled work is not claimable before this instant. */
  readonly dueAt?: number;
  readonly maximumAttempts?: number;
}

/**
 * The durable queue's read/write surface. `kind` is an opaque discriminator
 * (this campaign registers exactly one value elsewhere, `message-delivery`)
 * so a future work type is additive schema-wise, never a migration.
 */
export class MessageQueueStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  insertWorkItem(item: NewWorkItem): WorkItemRow {
    if (
      item.maximumAttempts !== undefined &&
      (!Number.isInteger(item.maximumAttempts) || item.maximumAttempts < 1)
    ) {
      throw new Error("maximumAttempts must be an integer >= 1");
    }
    const timestamp = this.now();
    if (item.dedupeKey !== undefined) {
      this.supersedeQueuedByDedupeKey(item.kind, item.dedupeKey, timestamp);
    }
    const row = this.db
      .prepare(
        `INSERT INTO work_items (kind, payload, state, failure_reason, created_at, updated_at, terminal_at, dedupe_key, due_at, attempt_count, maximum_attempts)
         VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, 0, ?)
         RETURNING id, kind, payload, state, failure_reason, created_at, updated_at, terminal_at, due_at, attempt_count, maximum_attempts`,
      )
      .get(
        item.kind,
        JSON.stringify(item.payload),
        MessageQueueWorkItemState.Queued,
        timestamp,
        timestamp,
        item.dedupeKey ?? null,
        item.dueAt ?? null,
        item.maximumAttempts ?? 1,
      ) as unknown as WorkItemSqlRow;
    return toWorkItemRow(row);
  }

  /**
   * Transitions every still-`queued` row sharing `(kind, dedupeKey)` to
   * `failed` — the supersede half of dedupe-on-enqueue. `in-flight` rows are
   * deliberately excluded: a delivery attempt already in progress runs to
   * its own terminal state rather than being cancelled out from under it.
   */
  private supersedeQueuedByDedupeKey(
    kind: string,
    dedupeKey: string,
    timestamp: number,
  ): void {
    this.db
      .prepare(
        `UPDATE work_items
         SET state = ?, failure_reason = ?, updated_at = ?, terminal_at = ?
         WHERE kind = ? AND dedupe_key = ? AND state = ?`,
      )
      .run(
        MessageQueueWorkItemState.Failed,
        SUPERSEDED_FAILURE_REASON,
        timestamp,
        timestamp,
        kind,
        dedupeKey,
        MessageQueueWorkItemState.Queued,
      );
  }

  readWorkItem(id: number): WorkItemRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id, kind, payload, state, failure_reason, created_at, updated_at, terminal_at, due_at, attempt_count, maximum_attempts
         FROM work_items WHERE id = ?`,
      )
      .get(id) as unknown as WorkItemSqlRow | undefined;
    return row === undefined ? undefined : toWorkItemRow(row);
  }

  /**
   * Applies exactly one forward step of the state machine. Throws rather
   * than silently clamping on a backward, repeated-terminal, or skipped
   * transition — a `failed` transition requires a non-empty reason and a
   * non-`failed` transition must not carry one.
   */
  transitionWorkItemState(
    id: number,
    to: MessageQueueWorkItemState,
    options: { failureReason?: string } = {},
  ): WorkItemRow {
    const current = this.readWorkItem(id);
    if (current === undefined) {
      throw new WorkItemNotFoundError(id);
    }
    if (!isForwardWorkItemStateTransition(current.state, to)) {
      throw new InvalidWorkItemStateTransitionError(id, current.state, to);
    }
    const failureReason = to === MessageQueueWorkItemState.Failed
      ? options.failureReason
      : undefined;
    if (to === MessageQueueWorkItemState.Failed && !failureReason) {
      throw new Error(
        `work item ${id} cannot transition to failed without a failure reason`,
      );
    }
    const timestamp = this.now();
    const terminalAt = TERMINAL_WORK_ITEM_STATES.has(to) ? timestamp : null;
    const row = this.db
      .prepare(
        `UPDATE work_items SET state = ?, failure_reason = ?, updated_at = ?, terminal_at = ?
         WHERE id = ?
         RETURNING id, kind, payload, state, failure_reason, created_at, updated_at, terminal_at, due_at, attempt_count, maximum_attempts`,
      )
      .get(to, failureReason ?? null, timestamp, terminalAt, id) as unknown as WorkItemSqlRow;
    const result = toWorkItemRow(row);
    // Closed-loop delivery reporting's one write site — never allowed to
    // throw back into the state machine; see `recordDeliveryFailureNoticeSafely`.
    if (to === MessageQueueWorkItemState.Failed) {
      recordDeliveryFailureNoticeSafely(this.db, result, timestamp);
    }
    return result;
  }

  /** See `delivery-failure-notice.store.ts` for all three thin delegators. */
  listUnacknowledgedDeliveryFailureNotices = (senderName: string): DeliveryFailureNoticeRow[] =>
    listUnacknowledgedDeliveryFailureNotices(this.db, senderName);
  acknowledgeDeliveryFailureNotice = (id: number): DeliveryFailureNoticeRow | undefined =>
    acknowledgeDeliveryFailureNotice(this.db, id, this.now());
  countAllUnacknowledgedDeliveryFailureNotices = (): number =>
    countAllUnacknowledgedDeliveryFailureNotices(this.db);

  /**
   * A terminal transition that tolerates losing a race to another owner of
   * the same item's terminal transition (startup reconciliation racing a
   * still-completing delivery handler, most concretely) instead of throwing.
   * If the item is already sitting in *some* terminal state and `to` is
   * itself terminal, this is a double-finish, not corruption: log it and
   * return the row as reconciliation (or the other handler) left it,
   * unchanged. Any other case — including a genuinely backward or
   * out-of-order transition — falls through to `transitionWorkItemState`
   * unchanged and still throws exactly as before. The store's state machine
   * stays strict; only this call-site guard is forgiving, and only for the
   * one class of race it is documented to tolerate.
   */
  finishWorkItemIdempotently(
    id: number,
    to: MessageQueueWorkItemState,
    options: { failureReason?: string } = {},
  ): WorkItemRow {
    const current = this.readWorkItem(id);
    if (
      current !== undefined &&
      TERMINAL_WORK_ITEM_STATES.has(current.state) &&
      TERMINAL_WORK_ITEM_STATES.has(to)
    ) {
      process.stderr.write(
        `throne-work: work item ${id} already terminal (${current.state}); ` +
          `skipping duplicate ${to} transition\n`,
      );
      return current;
    }
    return this.transitionWorkItemState(id, to, options);
  }

  /**
   * Every work item currently sitting in one of the given (non-terminal)
   * states, oldest first — the dispatch loop's poll query for due work and
   * for stuck `in-flight` items to resume after a restart.
   */
  listWorkItemsByStates(states: readonly MessageQueueWorkItemState[]): WorkItemRow[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, kind, payload, state, failure_reason, created_at, updated_at, terminal_at, due_at, attempt_count, maximum_attempts
         FROM work_items WHERE state IN (${placeholders})
         ORDER BY created_at ASC`,
      )
      .all(...states) as unknown as WorkItemSqlRow[];
    return rows.map(toWorkItemRow);
  }

  /** Claims one eligible queued row atomically, so cancellation loses once this succeeds. */
  claimDueWorkItem(id: number): WorkItemRow | undefined {
    const timestamp = this.now();
    const row = this.db.prepare(
      `UPDATE work_items SET state = ?, updated_at = ?, attempt_count = attempt_count + 1
       WHERE id = ? AND state = ? AND (due_at IS NULL OR due_at <= ?)
       RETURNING id, kind, payload, state, failure_reason, created_at, updated_at, terminal_at, due_at, attempt_count, maximum_attempts`,
    ).get(
      MessageQueueWorkItemState.InFlight,
      timestamp,
      id,
      MessageQueueWorkItemState.Queued,
      timestamp,
    ) as unknown as WorkItemSqlRow | undefined;
    return row === undefined ? undefined : toWorkItemRow(row);
  }

  failDeliveryAttempt(
    id: number,
    failureReason: string,
    backoffMilliseconds: number,
  ): WorkItemRow {
    if (failureReason.length === 0) {
      throw new Error(`work item ${id} cannot fail without a failure reason`);
    }
    if (!Number.isFinite(backoffMilliseconds) || backoffMilliseconds < 0) {
      throw new Error("backoffMilliseconds must be a finite number >= 0");
    }
    const current = this.readWorkItem(id);
    if (current === undefined) throw new WorkItemNotFoundError(id);
    if (current.state !== MessageQueueWorkItemState.InFlight) {
      throw new InvalidWorkItemStateTransitionError(
        id,
        current.state,
        MessageQueueWorkItemState.Failed,
      );
    }
    const timestamp = this.now();
    const exhausted = current.attemptCount >= current.maximumAttempts;
    const state = exhausted
      ? MessageQueueWorkItemState.Failed
      : MessageQueueWorkItemState.Queued;
    const row = this.db.prepare(
      `UPDATE work_items
       SET state = ?, failure_reason = ?, due_at = ?, updated_at = ?, terminal_at = ?
       WHERE id = ? AND state = ? AND attempt_count = ?
       RETURNING id, kind, payload, state, failure_reason, created_at, updated_at, terminal_at, due_at, attempt_count, maximum_attempts`,
    ).get(
      state,
      failureReason,
      exhausted ? current.dueAt : timestamp + backoffMilliseconds,
      timestamp,
      exhausted ? timestamp : null,
      id,
      MessageQueueWorkItemState.InFlight,
      current.attemptCount,
    ) as unknown as WorkItemSqlRow | undefined;
    if (row === undefined) {
      const latest = this.readWorkItem(id);
      if (latest === undefined) throw new WorkItemNotFoundError(id);
      throw new InvalidWorkItemStateTransitionError(id, latest.state, state);
    }
    const result = toWorkItemRow(row);
    if (exhausted) {
      recordDeliveryFailureNoticeSafely(this.db, result, timestamp);
    }
    return result;
  }

  /**
   * Claims one due queued row in one write transaction: a never-scheduled row
   * (no `due_at`) before any rescheduled one, then the earliest due, then the
   * oldest. Plain creation order let a delivery that keeps yielding on an
   * occupied composer — rescheduled one second out, due again next tick, and
   * always the oldest — win every claim and starve every newer message for
   * the whole lane bound. Selecting before
   * the transaction would let two drain workers observe the same candidate;
   * `BEGIN IMMEDIATE` gives exactly one claimer ownership before it reads.
   *
   * The claimed row is returned only after the transaction commits. Delivery
   * therefore occurs after SQLite's write lock has been released.
   */
  claimNextDueWorkItem(kinds: readonly string[] = []): WorkItemRow | undefined {
    const timestamp = this.now();
    const kindPredicate = kinds.length === 0
      ? ""
      : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.db.prepare(
        `SELECT id FROM work_items
         WHERE state = ? AND (due_at IS NULL OR due_at <= ?)${kindPredicate}
         ORDER BY (due_at IS NOT NULL) ASC, due_at ASC, created_at ASC
         LIMIT 1`,
      ).get(
        MessageQueueWorkItemState.Queued,
        timestamp,
        ...kinds,
      ) as unknown as { id: number } | undefined;
      if (candidate === undefined) {
        this.db.exec("COMMIT");
        return undefined;
      }

      const row = this.db.prepare(
        `UPDATE work_items SET state = ?, updated_at = ?, attempt_count = attempt_count + 1
         WHERE id = ? AND state = ? AND (due_at IS NULL OR due_at <= ?)
         RETURNING id, kind, payload, state, failure_reason, created_at, updated_at, terminal_at, due_at, attempt_count, maximum_attempts`,
      ).get(
        MessageQueueWorkItemState.InFlight,
        timestamp,
        candidate.id,
        MessageQueueWorkItemState.Queued,
        timestamp,
      ) as unknown as WorkItemSqlRow | undefined;
      this.db.exec("COMMIT");
      return row === undefined ? undefined : toWorkItemRow(row);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // If BEGIN IMMEDIATE itself failed, no transaction exists to roll back.
      }
      throw error;
    }
  }

  rescheduleClaimedWorkItem(
    id: number,
    delayMs: number,
    accumulatedWaitMs: number,
  ): WorkItemRow {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error("delayMs must be a finite number >= 0");
    }
    if (!Number.isFinite(accumulatedWaitMs) || accumulatedWaitMs < 0) {
      throw new Error("accumulatedWaitMs must be a finite number >= 0");
    }
    const current = this.readWorkItem(id);
    if (current === undefined) throw new WorkItemNotFoundError(id);
    if (current.state !== MessageQueueWorkItemState.InFlight) {
      throw new InvalidWorkItemStateTransitionError(
        id,
        current.state,
        MessageQueueWorkItemState.Queued,
      );
    }
    const timestamp = this.now();
    const payload = {
      ...(current.payload as Record<string, unknown>),
      accumulatedWaitMs,
    };
    const row = this.db.prepare(
      `UPDATE work_items
       SET payload = ?, state = ?, due_at = ?, updated_at = ?
       WHERE id = ? AND state = ?
       RETURNING id, kind, payload, state, failure_reason, created_at, updated_at, terminal_at, due_at, attempt_count, maximum_attempts`,
    ).get(
      JSON.stringify(payload),
      MessageQueueWorkItemState.Queued,
      timestamp + delayMs,
      timestamp,
      id,
      MessageQueueWorkItemState.InFlight,
    ) as unknown as WorkItemSqlRow | undefined;
    if (row === undefined) {
      throw new InvalidWorkItemStateTransitionError(
        id,
        this.readWorkItem(id)?.state ?? MessageQueueWorkItemState.Cancelled,
        MessageQueueWorkItemState.Queued,
      );
    }
    return toWorkItemRow(row);
  }

  /** Cancels only an unclaimed row; an in-flight delivery has already won the race. */
  cancelQueuedWorkItem(id: number): WorkItemRow | undefined {
    const timestamp = this.now();
    const row = this.db.prepare(
      `UPDATE work_items SET state = ?, updated_at = ?, terminal_at = ?
       WHERE id = ? AND state = ?
       RETURNING id, kind, payload, state, failure_reason, created_at, updated_at, terminal_at, due_at, attempt_count, maximum_attempts`,
    ).get(
      MessageQueueWorkItemState.Cancelled,
      timestamp,
      timestamp,
      id,
      MessageQueueWorkItemState.Queued,
    ) as unknown as WorkItemSqlRow | undefined;
    return row === undefined ? undefined : toWorkItemRow(row);
  }

  /**
   * Deletes at most `batchSize` terminal rows whose `terminal_at` is older
   * than `MESSAGE_RETENTION_WINDOW_MS`, oldest-first — a bounded delete, not
   * a full-table scan, so one poll tick's sweep stays cheap regardless of
   * table size. A `queued`/`in-flight` row has `terminal_at IS NULL` and is
   * structurally excluded by the predicate, never touched by age alone.
   * Records the sweep's own count and timestamp so it stays observable even
   * when nothing was due.
   */
  sweepExpiredTerminalWorkItems(
    batchSize: number = MESSAGE_RETENTION_SWEEP_BATCH_SIZE,
  ): RetentionSweepResult {
    const sweptAt = this.now();
    const cutoff = sweptAt - MESSAGE_RETENTION_WINDOW_MS;
    const result = this.db
      .prepare(
        `DELETE FROM work_items WHERE id IN (
           SELECT id FROM work_items
           WHERE terminal_at IS NOT NULL AND terminal_at < ?
           ORDER BY terminal_at ASC
           LIMIT ?
         )`,
      )
      .run(cutoff, batchSize);
    const sweptCount = Number(result.changes);
    this.db
      .prepare(
        `INSERT INTO retention_sweep_runs (id, swept_count, swept_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET swept_count = excluded.swept_count, swept_at = excluded.swept_at`,
      )
      .run(sweptCount, sweptAt);
    return { sweptCount, sweptAt };
  }

  /** The last retention sweep's row count and when it ran — the observable surface. */
  readLastRetentionSweep(): RetentionSweepResult | undefined {
    const row = this.db
      .prepare(`SELECT swept_count, swept_at FROM retention_sweep_runs WHERE id = 1`)
      .get() as unknown as { swept_count: number; swept_at: number } | undefined;
    return row === undefined ? undefined : { sweptCount: row.swept_count, sweptAt: row.swept_at };
  }

  /** The server's liveness signal: the last time it wrote a heartbeat. */
  readHeartbeat(): number | undefined {
    const row = this.db
      .prepare(`SELECT updated_at FROM server_heartbeat WHERE id = 1`)
      .get() as unknown as { updated_at: number } | undefined;
    return row?.updated_at;
  }

  writeHeartbeat(timestamp: number = this.now()): void {
    this.db
      .prepare(
        `INSERT INTO server_heartbeat (id, updated_at) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(timestamp);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Opens (creating on first use) the durable queue database in WAL mode, so
 * concurrent readers (poll) and a single writer (enqueuers + the server)
 * don't block each other pathologically and an unclean shutdown mid-write
 * cannot corrupt already-committed rows. Schema creation is idempotent —
 * `CREATE TABLE IF NOT EXISTS` — so re-opening an existing database is a
 * no-op upgrade path; a single-table v1 schema needs no separate migration
 * tool.
 */
export function openMessageQueueStore(
  databasePath: string = resolveMessageQueueDatabasePath(),
  now: () => number = Date.now,
): MessageQueueStore {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  // busy_timeout FIRST: switching the journal mode takes the database lock,
  // and two processes opening the same store together (every drain tick
  // races the CLI's enqueue) otherwise fail the loser with SQLITE_BUSY on
  // the spot instead of waiting — seen as "database is locked" from the
  // suite's concurrent-claim test on a slow shared filesystem (2026-09-02).
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  createMessageQueueSchema(db);
  createDeliveryFailureNoticeSchema(db);
  return new MessageQueueStore(db, now);
}
