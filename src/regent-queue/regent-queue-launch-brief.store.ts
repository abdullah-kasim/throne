import type { DatabaseSync } from "node:sqlite";
import { RegentQueueItemStatus } from "./regent-queue-item-state.ts";
import type {
  QueueLaunchBriefReadResult,
  QueueLaunchBriefRow,
  StageQueueLaunchBrief,
  QueueLaunchBriefSqlRow,
} from "./regent-queue-launch-brief.ts";
import { toLaunchBriefRow } from "./regent-queue-launch-brief.ts";

export class RegentQueueLaunchBriefPersistence {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  stage(input: StageQueueLaunchBrief): QueueLaunchBriefRow {
    const item = this.db
      .prepare(
        `SELECT id, pr_branch FROM queue_items WHERE objective_code = ? AND status = ?`,
      )
      .get(input.objectiveCode, RegentQueueItemStatus.Open) as
      { id: string; pr_branch: string | null } | undefined;
    if (item === undefined) {
      throw new Error(
        `open queue objective "${input.objectiveCode}" does not exist`,
      );
    }
    const prBranch =
      input.prBranch !== undefined ? input.prBranch : item.pr_branch;
    const row = this.db
      .prepare(
        `INSERT INTO queue_launch_briefs
           (queue_item_id, canonical_name, target_repo, target_branch, base_commit, authorizer, briefed_at, lifecycle, expired_at, pr_branch)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)
         ON CONFLICT(queue_item_id) DO UPDATE SET
           canonical_name=excluded.canonical_name, target_repo=excluded.target_repo,
           target_branch=excluded.target_branch, base_commit=excluded.base_commit,
           authorizer=excluded.authorizer, briefed_at=excluded.briefed_at,
           lifecycle='active', expired_at=NULL, pr_branch=excluded.pr_branch
         RETURNING queue_item_id, ? AS objective_code, canonical_name, target_repo,
           target_branch, base_commit, authorizer, briefed_at, lifecycle, expired_at, pr_branch,
           (SELECT model_hint_harness FROM queue_items WHERE id = queue_item_id) AS model_hint_harness,
           (SELECT model_hint_model FROM queue_items WHERE id = queue_item_id) AS model_hint_model`,
      )
      .get(
        item.id,
        input.canonicalName,
        input.targetRepo,
        input.targetBranch,
        input.baseCommit,
        input.authorizer,
        this.now(),
        prBranch,
        input.objectiveCode,
      ) as unknown as QueueLaunchBriefSqlRow;
    return toLaunchBriefRow(row);
  }

  expire(objectiveCode: string, authorizer: string): QueueLaunchBriefRow {
    const row = this.db
      .prepare(
        `UPDATE queue_launch_briefs SET lifecycle='expired', expired_at=?, authorizer=?
         WHERE queue_item_id=(SELECT id FROM queue_items WHERE objective_code=?)
         RETURNING queue_item_id, ? AS objective_code, canonical_name, target_repo,
           target_branch, base_commit, authorizer, briefed_at, lifecycle, expired_at, pr_branch,
           (SELECT model_hint_harness FROM queue_items WHERE id = queue_item_id) AS model_hint_harness,
           (SELECT model_hint_model FROM queue_items WHERE id = queue_item_id) AS model_hint_model`,
      )
      .get(this.now(), authorizer, objectiveCode, objectiveCode) as unknown as
      QueueLaunchBriefSqlRow | undefined;
    if (row === undefined) {
      throw new Error(
        `launch brief for objective "${objectiveCode}" does not exist`,
      );
    }
    return toLaunchBriefRow(row);
  }

  expireActiveForQueueItem(queueItemId: string, timestamp: number): void {
    this.db
      .prepare(
        `UPDATE queue_launch_briefs SET lifecycle='expired', expired_at=? WHERE queue_item_id=? AND lifecycle='active'`,
      )
      .run(timestamp, queueItemId);
  }

  readAll(): QueueLaunchBriefReadResult {
    try {
      const rows = this.db
        .prepare(
          `SELECT b.queue_item_id, q.objective_code, b.canonical_name, b.target_repo,
             b.target_branch, b.base_commit, b.authorizer, b.briefed_at, b.lifecycle, b.expired_at, b.pr_branch,
             q.model_hint_harness, q.model_hint_model
           FROM queue_launch_briefs b JOIN queue_items q ON q.id=b.queue_item_id
           WHERE q.status=? ORDER BY q.created_at ASC`,
        )
        .all(RegentQueueItemStatus.Open) as unknown as QueueLaunchBriefSqlRow[];
      return rows.length === 0
        ? { state: "positively-empty" }
        : { state: "briefs", briefs: rows.map(toLaunchBriefRow) };
    } catch (error) {
      return {
        state: "unknown",
        reason: `launch brief read failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
