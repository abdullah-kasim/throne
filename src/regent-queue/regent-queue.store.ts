import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { archiveQueueItems } from "./regent-queue-archive.ts";
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
  type QueueDeliverableShape,
  type QueueDeferral,
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
import type { ModelPair } from "../config.ts";
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

/**
 * The store's on-disk home: one SQLite file under the durable throne ledger
 * area (never `/tmp`), so a crashed Regent, a dead CLI invocation, or a
 * reboot never loses queue state. Mirrors
 * `outage-marker.store.ts`/`message-queue.store.ts`'s convention of a
 * dedicated file for its own concern rather than sharing one.
 */
/** A new item's fields. `id` and `status` are optional so migration import can pin a specific id and a
 * non-open starting status (preserving QUEUE.md's current state); `add-to-queue` omits both and gets a
 * generated id in the open status. */
export interface NewQueueItem {
  readonly id?: string;
  readonly objectiveCode?: string | null;
  readonly status?: RegentQueueItemStatus;
  readonly body: string;
  readonly prBranch?: string | null;
  readonly modelHint?: ModelPair | null;
  readonly deliverableShape?: QueueDeliverableShape | null;
  readonly launch?: EligibleQueueLaunchMetadata;
  readonly deliveryMirror?: QueueDeliveryMirror;
  readonly absorption?: QueueAbsorption | null;
  readonly priority?: number;
}

/** Fields a lifecycle write-back or migration import may set while transitioning a status. */
export interface QueueItemTransitionFields {
  readonly agentName?: string;
  readonly targetRepo?: string;
  readonly baseCommit?: string;
  readonly deliveryCommit?: string;
}

export interface QueueItemMutation {
  readonly status?: RegentQueueItemStatus;
  /** Set when deferring; cleared automatically whenever the row leaves
   *  `deferred`, so a stale hold can never linger on a live row. */
  readonly deferral?: QueueDeferral | null;

  readonly body?: string;
  readonly prBranch?: string | null;
  readonly agentName?: string | null;
  readonly targetRepo?: string | null;
  readonly baseCommit?: string | null;
  readonly deliveryCommit?: string | null;
  readonly deliveryMirror?: QueueDeliveryMirror;
  readonly absorption?: QueueAbsorption | null;
  readonly priority?: number;
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
  mutateItem(id: string, mutation: QueueItemMutation): RegentQueueItemRow;
}

export interface RegentQueueValidationStore extends RegentQueueStore {
  markValidationRequired(objectiveCode: string): RegentQueueItemRow;
}

export interface RegentQueueLaunchBriefStore extends RegentQueueStore {
  stageLaunchBrief(input: StageQueueLaunchBrief): QueueLaunchBriefRow;
  expireLaunchBrief(
    objectiveCode: string,
    authorizer: string,
  ): QueueLaunchBriefRow;
  readLaunchBriefs(): QueueLaunchBriefReadResult;
}

export class RegentQueueSqliteStore implements RegentQueueMutationStore {
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
    const mirror =
      item.deliveryMirror === undefined
        ? undefined
        : requireQueueDeliveryMirror(item.deliveryMirror);
    const priority =
      item.priority === undefined ? 0 : requireQueuePriority(item.priority);
    const timestamp = this.now();
    const id = item.id ?? item.objectiveCode ?? randomUUID();
    const status = item.status ?? RegentQueueItemStatus.Open;
    const row = this.db
      .prepare(
        `INSERT INTO queue_items
           (id, objective_code, status, body, launch_eligible, launch_alpha_name, launch_target_repo, launch_target_branch, launch_base_commit, pr_branch, model_hint_harness, model_hint_model, deliverable_shape, agent_name, target_repo, base_commit, delivery_commit, validation_required, validation_required_at, delivery_mirror_state, delivery_mirror_commit, delivery_mirror_repo, delivery_mirror_branch, delivery_mirror_tree_identity, delivery_mirror_checked_at, delivery_mirror_reason, absorption_objective_code, absorption_delivery_commit, absorption_target_repo, absorption_target_branch, absorption_tree_identity, absorption_checked_at, absorption_reason, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ${queueItemColumns}`,
      )
      .get(
        id,
        item.objectiveCode ?? null,
        status,
        item.body,
        item.launch === undefined ? 0 : 1,
        item.launch?.alphaName ?? null,
        item.launch?.targetRepo ?? null,
        item.launch?.targetBranch ?? null,
        item.launch?.baseCommit ?? null,
        item.prBranch ?? null,
        item.modelHint?.harness ?? null,
        item.modelHint?.model ?? null,
        item.deliverableShape ?? null,
        item.launch?.targetRepo ?? null,
        item.launch?.baseCommit ?? null,
        mirror?.verdict ?? "unknown",
        mirror?.deliveryCommit ?? null,
        mirror?.targetRepo ?? null,
        mirror?.targetBranch ?? null,
        mirror?.treeIdentity ?? null,
        mirror?.checkedAt ?? null,
        mirror?.reason ?? null,
        item.absorption?.objectiveCode ?? null,
        item.absorption?.deliveryCommit ?? null,
        item.absorption?.targetRepo ?? null,
        item.absorption?.targetBranch ?? null,
        item.absorption?.treeIdentity ?? null,
        item.absorption?.checkedAt ?? null,
        item.absorption?.reason ?? null,
        priority,
        timestamp,
        timestamp,
      ) as unknown as QueueItemSqlRow;
    return toQueueItemRow(row);
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

  mutateItem(id: string, mutation: QueueItemMutation): RegentQueueItemRow {
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
    const nextDeferral =
      nextStatus === RegentQueueItemStatus.Deferred
        ? (mutation.deferral === undefined
            ? current.deferral
            : mutation.deferral)
        : null;
    const timestamp = this.now();
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
             deferred_release_authority = ?,
             deferred_reason = ?,
             priority = ?,
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
          mutation.absorption === undefined
            ? (current.absorption?.objectiveCode ?? null)
            : (mutation.absorption?.objectiveCode ?? null),
          mutation.absorption === undefined
            ? (current.absorption?.deliveryCommit ?? null)
            : (mutation.absorption?.deliveryCommit ?? null),
          mutation.absorption === undefined
            ? (current.absorption?.targetRepo ?? null)
            : (mutation.absorption?.targetRepo ?? null),
          mutation.absorption === undefined
            ? (current.absorption?.targetBranch ?? null)
            : (mutation.absorption?.targetBranch ?? null),
          mutation.absorption === undefined
            ? (current.absorption?.treeIdentity ?? null)
            : (mutation.absorption?.treeIdentity ?? null),
          mutation.absorption === undefined
            ? (current.absorption?.checkedAt ?? null)
            : (mutation.absorption?.checkedAt ?? null),
          mutation.absorption === undefined
            ? (current.absorption?.reason ?? null)
            : (mutation.absorption?.reason ?? null),
          // A hold is only meaningful while the row is deferred. Writing these
          // as null the moment the status leaves `deferred` means a released
          // row can never carry a ghost dependency list that a later reader
          // mistakes for a live hold.
          nextDeferral === null ? null : nextDeferral.dependsOn.join(","),
          nextDeferral?.releaseAuthority ?? null,
          nextDeferral?.reason ?? null,
          priority,
          timestamp,
          id,
        ) as unknown as QueueItemSqlRow;
      if (
        mutation.status === RegentQueueItemStatus.Complete ||
        mutation.status === RegentQueueItemStatus.Abandoned
      ) {
        this.launchBriefPersistence.expireActiveForQueueItem(id, timestamp);
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

  close(): void {
    this.db.close();
  }
}

export function openRegentQueueStore(
  databasePath: string = resolveRegentQueueDatabasePath(),
  now: () => number = Date.now,
): RegentQueueLaunchBriefStore &
  RegentQueueMutationStore &
  RegentQueueValidationStore {
  return new RegentQueueSqliteStore(openRegentQueueDatabase(databasePath), now);
}
