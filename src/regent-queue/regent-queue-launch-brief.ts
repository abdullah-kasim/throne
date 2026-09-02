import type { ModelPair } from "../config.ts";

export interface QueueLaunchEligibility {
  readonly eligible: boolean;
  readonly reason: string;
  readonly alphaName: string | null;
  readonly targetRepo: string | null;
  readonly targetBranch: string | null;
  readonly baseCommit: string | null;
}

export interface EligibleQueueLaunchMetadata {
  readonly alphaName: string;
  readonly targetRepo: string;
  readonly targetBranch: string;
  readonly baseCommit: string;
}

export interface StageQueueLaunchBrief {
  readonly objectiveCode: string;
  readonly canonicalName: string;
  readonly targetRepo: string;
  readonly targetBranch: string;
  readonly baseCommit: string;
  readonly authorizer: string;
  readonly prBranch?: string | null;
}

export interface QueueLaunchBriefRow extends StageQueueLaunchBrief {
  readonly prBranch: string | null;
  readonly queueItemId: string;
  readonly briefedAt: number;
  readonly lifecycle: "active" | "expired";
  readonly expiredAt: number | null;
  readonly modelHint: ModelPair | null;
}

export type QueueLaunchBriefReadResult =
  | { readonly state: "briefs"; readonly briefs: QueueLaunchBriefRow[] }
  | { readonly state: "positively-empty" }
  | { readonly state: "unknown"; readonly reason: string };

export interface QueueLaunchBriefSqlRow {
  queue_item_id: string;
  objective_code: string;
  canonical_name: string;
  target_repo: string;
  target_branch: string;
  base_commit: string;
  authorizer: string;
  briefed_at: number;
  lifecycle: string;
  expired_at: number | null;
  pr_branch: string | null;
  model_hint_harness?: string | null;
  model_hint_model?: string | null;
}

export function toLaunchBriefRow(
  row: QueueLaunchBriefSqlRow,
): QueueLaunchBriefRow {
  return {
    queueItemId: row.queue_item_id,
    objectiveCode: row.objective_code,
    canonicalName: row.canonical_name,
    targetRepo: row.target_repo,
    targetBranch: row.target_branch,
    baseCommit: row.base_commit,
    authorizer: row.authorizer,
    briefedAt: row.briefed_at,
    lifecycle: row.lifecycle as "active" | "expired",
    expiredAt: row.expired_at,
    prBranch: row.pr_branch,
    modelHint:
      row.model_hint_harness === null ||
      row.model_hint_harness === undefined ||
      row.model_hint_model === null ||
      row.model_hint_model === undefined
        ? null
        : {
            harness: row.model_hint_harness as ModelPair["harness"],
            model: row.model_hint_model,
          },
  };
}
