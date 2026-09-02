import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RegentQueueItemStatus } from "./regent-queue-item-state.ts";

export interface QueueArchiveRequest {
  readonly actor: string;
  readonly predicate: string;
  readonly itemIds: readonly string[];
  readonly operationId?: string;
}

export interface QueueArchiveResult {
  readonly operationId: string;
  readonly operatedAt: number;
  readonly rowCount: number;
}

interface QueueArchiveSourceRow {
  id: string;
  objective_code: string | null;
  status: string;
  body: string;
  launch_eligible: number;
  launch_alpha_name: string | null;
  launch_target_repo: string | null;
  launch_target_branch: string | null;
  launch_base_commit: string | null;
  pr_branch: string | null;
  agent_name: string | null;
  target_repo: string | null;
  base_commit: string | null;
  delivery_commit: string | null;
  validation_required: number;
  validation_required_at: number | null;
  delivery_mirror_state: string;
  delivery_mirror_commit: string | null;
  delivery_mirror_repo: string | null;
  delivery_mirror_branch: string | null;
  delivery_mirror_tree_identity: string | null;
  delivery_mirror_checked_at: number | null;
  delivery_mirror_reason: string | null;
  absorption_objective_code: string | null;
  absorption_delivery_commit: string | null;
  absorption_target_repo: string | null;
  absorption_target_branch: string | null;
  absorption_tree_identity: string | null;
  absorption_checked_at: number | null;
  absorption_reason: string | null;
  priority: number;
  created_at: number;
  updated_at: number;
}

export function archiveQueueItems(
  db: DatabaseSync,
  now: () => number,
  input: QueueArchiveRequest,
): QueueArchiveResult {
  if (input.actor.trim() === "" || input.predicate.trim() === "") {
    throw new Error("queue archive requires actor and predicate");
  }
  const operationId = input.operationId ?? randomUUID();
  if (new Set(input.itemIds).size !== input.itemIds.length) {
    throw new Error("queue archive item IDs must be unique");
  }
  const operatedAt = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = input.itemIds
      .map(
        (id) =>
          db
            .prepare(
              `SELECT id, objective_code, status, body, launch_eligible, launch_alpha_name, launch_target_repo, launch_target_branch, launch_base_commit, pr_branch, agent_name, target_repo, base_commit, delivery_commit, validation_required, validation_required_at, delivery_mirror_state, delivery_mirror_commit, delivery_mirror_repo, delivery_mirror_branch, delivery_mirror_tree_identity, delivery_mirror_checked_at, delivery_mirror_reason, absorption_objective_code, absorption_delivery_commit, absorption_target_repo, absorption_target_branch, absorption_tree_identity, absorption_checked_at, absorption_reason, priority, created_at, updated_at FROM queue_items WHERE id = ? AND status IN (?, ?)`,
            )
            .get(
              id,
              RegentQueueItemStatus.Complete,
              RegentQueueItemStatus.Abandoned,
            ) as unknown as QueueArchiveSourceRow | undefined,
      )
      .filter((row): row is QueueArchiveSourceRow => row !== undefined);
    db.prepare(
      `INSERT INTO queue_mutation_audit (operation_id, actor, predicate, operated_at, row_count) VALUES (?, ?, ?, ?, ?)`,
    ).run(operationId, input.actor, input.predicate, operatedAt, rows.length);
    const insert = db.prepare(
      `INSERT INTO queue_item_archive (archive_id, operation_id, item_id, objective_code, status, body, launch_eligible, launch_alpha_name, launch_target_repo, launch_target_branch, launch_base_commit, pr_branch, agent_name, target_repo, base_commit, delivery_commit, validation_required, validation_required_at, delivery_mirror_state, delivery_mirror_commit, delivery_mirror_repo, delivery_mirror_branch, delivery_mirror_tree_identity, delivery_mirror_checked_at, delivery_mirror_reason, absorption_objective_code, absorption_delivery_commit, absorption_target_repo, absorption_target_branch, absorption_tree_identity, absorption_checked_at, absorption_reason, priority, created_at, updated_at, archived_at, actor, predicate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const removeExpiredBrief = db.prepare(
      `DELETE FROM queue_launch_briefs WHERE queue_item_id = ? AND lifecycle = 'expired'`,
    );
    const removeItem = db.prepare(
      `DELETE FROM queue_items WHERE id = ? AND status IN (?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        randomUUID(),
        operationId,
        row.id,
        row.objective_code,
        row.status,
        row.body,
        row.launch_eligible,
        row.launch_alpha_name,
        row.launch_target_repo,
        row.launch_target_branch,
        row.launch_base_commit,
        row.pr_branch,
        row.agent_name,
        row.target_repo,
        row.base_commit,
        row.delivery_commit,
        row.validation_required,
        row.validation_required_at,
        row.delivery_mirror_state,
        row.delivery_mirror_commit,
        row.delivery_mirror_repo,
        row.delivery_mirror_branch,
        row.delivery_mirror_tree_identity,
        row.delivery_mirror_checked_at,
        row.delivery_mirror_reason,
        row.absorption_objective_code,
        row.absorption_delivery_commit,
        row.absorption_target_repo,
        row.absorption_target_branch,
        row.absorption_tree_identity,
        row.absorption_checked_at,
        row.absorption_reason,
        row.priority,
        row.created_at,
        row.updated_at,
        operatedAt,
        input.actor,
        input.predicate,
      );
      removeExpiredBrief.run(row.id);
      removeItem.run(
        row.id,
        RegentQueueItemStatus.Complete,
        RegentQueueItemStatus.Abandoned,
      );
    }
    db.exec("COMMIT");
    return { operationId, operatedAt, rowCount: rows.length };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
