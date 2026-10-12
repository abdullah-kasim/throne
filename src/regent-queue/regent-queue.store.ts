import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  archiveQueueItems,
  recordQueueMutationAudit,
} from "./regent-queue-archive.ts";
import { insertQueueItem, type NewQueueItem } from "./regent-queue-insert.ts";
import {
  outcomeColumnsAfterMutation,
  type QueueOutcomeMutation,
} from "./regent-queue-outcome.ts";
export type { NewQueueItem } from "./regent-queue-insert.ts";
import {
  openRegentQueueDatabase,
  resolveRegentQueueDatabasePath,
} from "./regent-queue-database.ts";
export {
  REGENT_QUEUE_DATABASE_FILE_NAME,
  resolveRegentQueueDatabasePath,
} from "./regent-queue-database.ts";
import { RegentQueueLaunchBriefPersistence } from "./regent-queue-launch-brief.store.ts";
import type {
  QueueLaunchBriefReadResult,
  QueueLaunchBriefRow,
  StageQueueLaunchBrief,
} from "./regent-queue-launch-brief.ts";
export type {
  EligibleQueueLaunchMetadata,
  QueueLaunchBriefReadResult,
  QueueLaunchBriefRow,
  QueueLaunchEligibility,
  StageQueueLaunchBrief,
} from "./regent-queue-launch-brief.ts";
import {
  type QueueDeferralRequest,
  type QueueReleaseRequest,
  queueItemColumns,
  requireQueueDeliveryMirror,
  requireQueuePriority,
  toQueueItemRow,
} from "./regent-queue-row.ts";
import type {
  QueueAbsorption,
  QueueDeliveryMirror,
  QueueItemSqlRow,
  RegentQueueItemRow,
} from "./regent-queue-row.ts";
import type { EligibleQueueLaunchMetadata } from "./regent-queue-launch-brief.ts";
export { isQueueDeliveryMirrorVerdict } from "./regent-queue-row.ts";
export type {
  QueueAbsorption,
  QueueDeliveryMirror,
  QueueDeliveryMirrorVerdict,
  RegentQueueItemRow,
} from "./regent-queue-row.ts";
import type {
  QueueArchiveRequest,
  QueueArchiveResult,
} from "./regent-queue-archive.ts";
export type {
  QueueArchiveRequest,
  QueueArchiveResult,
} from "./regent-queue-archive.ts";
import {
  InvalidQueueItemStatusTransitionError,
  isForwardQueueItemStatusTransition,
  QueueItemNotFoundError,
  RegentQueueItemStatus,
} from "./regent-queue-item-state.ts";
export {
  InvalidQueueItemStatusTransitionError,
  isForwardQueueItemStatusTransition,
  QueueItemNotFoundError,
  RegentQueueItemStatus,
};

/** Fields a lifecycle write-back or migration import may set while transitioning a status. */
export interface QueueItemTransitionFields extends QueueOutcomeMutation {
  readonly agentName?: string;
  readonly targetRepo?: string;
  readonly baseCommit?: string;
  readonly deliveryCommit?: string;
}

export interface QueueItemMutation extends QueueOutcomeMutation {
  readonly status?: RegentQueueItemStatus;
  readonly deferral?: QueueDeferralRequest | null;
  readonly release?: QueueReleaseRequest;
  readonly body?: string;
  readonly prBranch?: string | null;
  readonly agentName?: string | null;
  readonly targetRepo?: string | null;
  readonly baseCommit?: string | null;
  readonly deliveryCommit?: string | null;
  readonly deliveryMirror?: QueueDeliveryMirror;
  readonly absorption?: QueueAbsorption | null;
  readonly priority?: number;
  readonly effort?: number | null;
}

export interface QueueMutationAuditRequest {
  readonly actor: string;
  readonly predicate: string;
}

/**
 * Tri-state read result: `items` (one or more rows), `positively-empty` (the
 * table is readable and has zero rows), or `unknown` (the read itself
 * failed) — mirrors `ReadyQueueResult`'s shape for a different entity. This
 * store's reads never collapse "could not read" into "empty".
 */
export type RegentQueueReadResult =
  | { readonly state: "items"; readonly items: RegentQueueItemRow[] }
  | { readonly state: "positively-empty" }
  | { readonly state: "unknown"; readonly reason: string };

/** The durable Regent queue read/write surface, for injecting a fake in tests. */
export interface RegentQueueStore {
  insertItem(item: NewQueueItem): RegentQueueItemRow;
  readItem(id: string): RegentQueueItemRow | undefined;
  readAll(): RegentQueueReadResult;
  transitionStatus(
    id: string,
    to: RegentQueueItemStatus,
    fields?: QueueItemTransitionFields,
  ): RegentQueueItemRow;
  markLaunchEligible(
    id: string,
    metadata: EligibleQueueLaunchMetadata,
  ): RegentQueueItemRow;
  archiveItems(input: QueueArchiveRequest): QueueArchiveResult;
  close(): void;
}

export interface RegentQueueMutationStore extends RegentQueueStore {
  mutateItem(
    id: string,
    mutation: QueueItemMutation,
    audit?: QueueMutationAuditRequest,
  ): RegentQueueItemRow;
}

export interface RegentQueueValidationStore extends RegentQueueStore {
  markValidationRequired(objectiveCode: string): RegentQueueItemRow;
}

export interface DeferredRowPingQueue {
  readAll(): RegentQueueReadResult;
  readDeferredRowPings(): ReadonlyMap<string, number>;
  recordDeferredRowPing(pingKey: string, pingedAt: number): void;
  close(): void;
}

export interface RegentQueueLaunchBriefStore extends RegentQueueStore {
  stageLaunchBrief(input: StageQueueLaunchBrief): QueueLaunchBriefRow;
  expireLaunchBrief(
    objectiveCode: string,
    authorizer: string,
  ): QueueLaunchBriefRow;
  readLaunchBriefs(): QueueLaunchBriefReadResult;
}

export class RegentQueueSqliteStore
  implements RegentQueueMutationStore, DeferredRowPingQueue
{
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly launchBriefPersistence: RegentQueueLaunchBriefPersistence;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
    this.launchBriefPersistence = new RegentQueueLaunchBriefPersistence(
      db,
      now,
    );
  }

  insertItem(item: NewQueueItem): RegentQueueItemRow {
    return insertQueueItem(this.db, this.now(), item);
  }

  readItem(id: string): RegentQueueItemRow | undefined {
    const row = this.db
      .prepare(
        `SELECT ${queueItemColumns}
         FROM queue_items WHERE id = ?`,
      )
      .get(id) as unknown as QueueItemSqlRow | undefined;
    return row === undefined ? undefined : toQueueItemRow(row);
  }

  readAll(): RegentQueueReadResult {
    let rows: QueueItemSqlRow[];
    try {
      rows = this.db
        .prepare(
          `SELECT ${queueItemColumns}
           FROM queue_items ORDER BY created_at ASC`,
        )
        .all() as unknown as QueueItemSqlRow[];
    } catch (error) {
      return {
        state: "unknown",
        reason: `regent queue read failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (rows.length === 0) {
      return { state: "positively-empty" };
    }
    return { state: "items", items: rows.map(toQueueItemRow) };
  }

  /**
   * Applies exactly one forward step of the state machine (per
   * `regent-queue-item-state.ts`), optionally setting the lifecycle-linkage
   * fields a `create-agent`/`reap-agent` write-back or migration import
   * supplies. Throws rather than silently clamping on a backward or
   * unsupported transition.
   */
  transitionStatus(
    id: string,
    to: RegentQueueItemStatus,
    fields: QueueItemTransitionFields = {},
  ): RegentQueueItemRow {
    const current = this.readItem(id);
    if (current === undefined) {
      throw new QueueItemNotFoundError(id);
    }
    if (!isForwardQueueItemStatusTransition(current.status, to)) {
      throw new InvalidQueueItemStatusTransitionError(id, current.status, to);
    }
    return this.mutateItem(id, { status: to, ...fields });
  }

  markLaunchEligible(
    id: string,
    metadata: EligibleQueueLaunchMetadata,
  ): RegentQueueItemRow {
    const values = [
      metadata.alphaName,
      metadata.targetRepo,
      metadata.targetBranch,
      metadata.baseCommit,
    ];
    if (values.some((value) => value.trim() === "")) {
      throw new Error(
        "launch eligibility requires complete non-empty metadata",
      );
    }
    const timestamp = this.now();
    const row = this.db
      .prepare(
        `UPDATE queue_items
         SET launch_eligible = 1,
             launch_alpha_name = ?,
             launch_target_repo = ?,
             launch_target_branch = ?,
             launch_base_commit = ?,
             updated_at = ?
         WHERE id = ? AND status = ?
         RETURNING ${queueItemColumns}`,
      )
      .get(
        metadata.alphaName,
        metadata.targetRepo,
        metadata.targetBranch,
        metadata.baseCommit,
        timestamp,
        id,
        RegentQueueItemStatus.Open,
      ) as unknown as QueueItemSqlRow | undefined;
    if (row !== undefined) return toQueueItemRow(row);
    const current = this.readItem(id);
    if (current === undefined) throw new QueueItemNotFoundError(id);
    throw new Error(`queue item "${id}" is "${current.status}", not "open"`);
  }

  markValidationRequired(objectiveCode: string): RegentQueueItemRow {
    const timestamp = this.now();
    const row = this.db
      .prepare(
        `UPDATE queue_items
       SET validation_required = 1,
           validation_required_at = COALESCE(validation_required_at, ?),
           updated_at = ?
       WHERE objective_code = ?
       RETURNING ${queueItemColumns}`,
      )
      .get(timestamp, timestamp, objectiveCode) as unknown as
      QueueItemSqlRow | undefined;
    if (row === undefined) throw new QueueItemNotFoundError(objectiveCode);
    return toQueueItemRow(row);
  }

  mutateItem(
    id: string,
    mutation: QueueItemMutation,
    audit?: QueueMutationAuditRequest,
  ): RegentQueueItemRow {
    const current = this.readItem(id);
    if (current === undefined) throw new QueueItemNotFoundError(id);
    const mirror =
      mutation.deliveryMirror === undefined
        ? current.deliveryMirror
        : requireQueueDeliveryMirror(mutation.deliveryMirror);
    const priority =
      mutation.priority === undefined
        ? current.priority
        : requireQueuePriority(mutation.priority);
    const nextStatus = mutation.status ?? current.status;
    const timestamp = this.now();
    const requestedDeferral =
      mutation.deferral === undefined ? current.deferral : mutation.deferral;
    const nextDeferral =
      nextStatus === RegentQueueItemStatus.Deferred
        ? {
            dependsOn: requestedDeferral?.dependsOn ?? [],
            reason: requestedDeferral?.reason ?? null,
            deferredAt: current.deferral?.deferredAt ?? timestamp,
          }
        : null;
    const absorption =
      mutation.absorption === undefined ? current.absorption : mutation.absorption;
    const release =
      mutation.release === undefined
        ? current.release
        : { ...mutation.release, releasedAt: timestamp };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `UPDATE queue_items
         SET status = ?,
             body = ?,
             pr_branch = ?,
             agent_name = ?,
             target_repo = ?,
             base_commit = ?,
             delivery_commit = ?,
             delivery_mirror_state = ?,
             delivery_mirror_commit = ?,
             delivery_mirror_repo = ?,
             delivery_mirror_branch = ?,
             delivery_mirror_tree_identity = ?,
             delivery_mirror_checked_at = ?,
             delivery_mirror_reason = ?,
             absorption_objective_code = ?,
             absorption_delivery_commit = ?,
             absorption_target_repo = ?,
             absorption_target_branch = ?,
             absorption_tree_identity = ?,
             absorption_checked_at = ?,
             absorption_reason = ?,
             deferred_depends_on = ?,
             deferred_reason = ?,
             deferred_at = ?,
             release_requested_by = ?,
             released_by = ?,
             release_reason = ?,
             released_at = ?,
             outcome = ?,
             outcome_summary = ?,
             pr_url = ?,
             result_commit = ?,
             completed_at = ?,
             priority = ?,
             effort = ?,
             updated_at = ?
         WHERE id = ?
         RETURNING ${queueItemColumns}`,
        )
        .get(
          mutation.status ?? current.status,
          mutation.body ?? current.body,
          mutation.prBranch === undefined
            ? current.prBranch
            : mutation.prBranch,
          mutation.agentName === undefined
            ? current.agentName
            : mutation.agentName,
          mutation.targetRepo === undefined
            ? current.targetRepo
            : mutation.targetRepo,
          mutation.baseCommit === undefined
            ? current.baseCommit
            : mutation.baseCommit,
          mutation.deliveryCommit === undefined
            ? current.deliveryCommit
            : mutation.deliveryCommit,
          mirror.verdict,
          mirror.deliveryCommit,
          mirror.targetRepo,
          mirror.targetBranch,
          mirror.treeIdentity,
          mirror.checkedAt,
          mirror.reason,
          absorption?.objectiveCode ?? null,
          absorption?.deliveryCommit ?? null,
          absorption?.targetRepo ?? null,
          absorption?.targetBranch ?? null,
          absorption?.treeIdentity ?? null,
          absorption?.checkedAt ?? null,
          absorption?.reason ?? null,
          nextDeferral === null ? null : nextDeferral.dependsOn.join(","),
          nextDeferral?.reason ?? null,
          nextDeferral?.deferredAt ?? null,
          release?.requestedBy ?? null,
          release?.releasedBy ?? null,
          release?.reason ?? null,
          release?.releasedAt ?? null,
          ...outcomeColumnsAfterMutation(current, mutation, nextStatus, timestamp),
          priority,
          mutation.effort === undefined ? current.effort ?? null : mutation.effort,
          timestamp,
          id,
        ) as unknown as QueueItemSqlRow;
      if (
        mutation.status === RegentQueueItemStatus.Complete ||
        mutation.status === RegentQueueItemStatus.Abandoned
      ) {
        this.launchBriefPersistence.expireActiveForQueueItem(id, timestamp);
      }
      if (audit !== undefined) {
        recordQueueMutationAudit(this.db, {
          operationId: randomUUID(),
          actor: audit.actor,
          predicate: audit.predicate,
          operatedAt: timestamp,
          rowCount: 1,
        });
      }
      this.db.exec("COMMIT");
      return toQueueItemRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  archiveItems(input: QueueArchiveRequest): QueueArchiveResult {
    return archiveQueueItems(this.db, this.now, input);
  }
  stageLaunchBrief(input: StageQueueLaunchBrief): QueueLaunchBriefRow {
    return this.launchBriefPersistence.stage(input);
  }

  expireLaunchBrief(
    objectiveCode: string,
    authorizer: string,
  ): QueueLaunchBriefRow {
    return this.launchBriefPersistence.expire(objectiveCode, authorizer);
  }

  readLaunchBriefs(): QueueLaunchBriefReadResult {
    return this.launchBriefPersistence.readAll();
  }

  readDeferredRowPings(): ReadonlyMap<string, number> {
    const rows = this.db
      .prepare(`SELECT ping_key, pinged_at FROM deferred_row_pings`)
      .all() as unknown as Array<{ ping_key: string; pinged_at: number }>;
    return new Map(rows.map((row) => [row.ping_key, Number(row.pinged_at)]));
  }

  recordDeferredRowPing(pingKey: string, pingedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO deferred_row_pings (ping_key, pinged_at) VALUES (?, ?)
         ON CONFLICT(ping_key) DO UPDATE SET pinged_at = excluded.pinged_at`,
      )
      .run(pingKey, pingedAt);
  }

  close(): void {
    this.db.close();
  }
}

export function openRegentQueueStore(
  databasePath: string = resolveRegentQueueDatabasePath(),
  now: () => number = Date.now,
): RegentQueueLaunchBriefStore &
  RegentQueueMutationStore &
  RegentQueueValidationStore &
  DeferredRowPingQueue {
  return new RegentQueueSqliteStore(openRegentQueueDatabase(databasePath), now);
}
