import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ModelPair } from "../config.ts";
import { RegentQueueItemStatus } from "./regent-queue-item-state.ts";
import type { EligibleQueueLaunchMetadata } from "./regent-queue-launch-brief.ts";
import {
  type QueueAbsorption,
  type QueueDeliverableShape,
  type QueueDeliveryMirror,
  type QueueItemSqlRow,
  type RegentQueueItemRow,
  queueItemColumns,
  requireQueueDeliveryMirror,
  requireQueuePriority,
  toQueueItemRow,
} from "./regent-queue-row.ts";

export interface NewQueueItem {
  readonly id?: string;
  readonly objectiveCode?: string | null;
  readonly status?: RegentQueueItemStatus;
  readonly body: string;
  readonly prBranch?: string | null;
  readonly modelHint?: ModelPair | null;
  readonly deliverableShape?: QueueDeliverableShape | null;
  readonly shadowless?: boolean;
  readonly sliceless?: boolean;
  readonly effort?: number | null;
  readonly launch?: EligibleQueueLaunchMetadata;
  readonly deliveryMirror?: QueueDeliveryMirror;
  readonly absorption?: QueueAbsorption | null;
  readonly priority?: number;
  readonly filedBy?: string | null;
}

export function insertQueueItem(
  db: DatabaseSync,
  timestamp: number,
  item: NewQueueItem,
): RegentQueueItemRow {
  const mirror =
    item.deliveryMirror === undefined
      ? undefined
      : requireQueueDeliveryMirror(item.deliveryMirror);
  const priority =
    item.priority === undefined ? 0 : requireQueuePriority(item.priority);
  const id = item.id ?? item.objectiveCode ?? randomUUID();
  const status = item.status ?? RegentQueueItemStatus.Open;
  const row = db
    .prepare(
      `INSERT INTO queue_items
         (id, objective_code, status, body, launch_eligible, launch_alpha_name, launch_target_repo, launch_target_branch, launch_base_commit, pr_branch, model_hint_harness, model_hint_model, deliverable_shape, shadowless, sliceless, effort, agent_name, target_repo, base_commit, delivery_commit, validation_required, validation_required_at, delivery_mirror_state, delivery_mirror_commit, delivery_mirror_repo, delivery_mirror_branch, delivery_mirror_tree_identity, delivery_mirror_checked_at, delivery_mirror_reason, absorption_objective_code, absorption_delivery_commit, absorption_target_repo, absorption_target_branch, absorption_tree_identity, absorption_checked_at, absorption_reason, priority, filed_by, deferred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      item.shadowless === true ? 1 : 0,
      item.sliceless === true ? 1 : 0,
      item.effort ?? null,
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
      item.filedBy ?? null,
      status === RegentQueueItemStatus.Deferred ? timestamp : null,
      timestamp,
      timestamp,
    ) as unknown as QueueItemSqlRow;
  return toQueueItemRow(row);
}
