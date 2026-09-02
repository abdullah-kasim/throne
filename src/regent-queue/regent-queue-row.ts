import { RegentQueueItemStatus } from "./regent-queue-item-state.ts";
import type { QueueLaunchEligibility } from "./regent-queue-launch-brief.ts";
import type { ModelPair } from "../config.ts";

export interface RegentQueueItemRow {
  readonly id: string;
  readonly objectiveCode: string | null;
  readonly status: RegentQueueItemStatus;
  readonly body: string;
  readonly prBranch: string | null;
  readonly modelHint?: ModelPair | null;
  /** `verdict-only`: the objective's deliverable is an answer, not a diff —
   *  the autoscaler forwards it to `create-agent --deliverable-shape`, so the
   *  Alpha's branch may legitimately never advance and `reap-agent --reason
   *  completed` still closes this row. */
  readonly deliverableShape?: QueueDeliverableShape | null;
  readonly launchEligibility?: QueueLaunchEligibility;
  readonly agentName: string | null;
  readonly targetRepo: string | null;
  readonly baseCommit: string | null;
  readonly deliveryCommit: string | null;
  readonly validationRequired?: boolean;
  readonly validationRequiredAt?: number | null;
  readonly deliveryMirror: QueueDeliveryMirror;
  readonly absorption: QueueAbsorption | null;
  /** Set only while `status` is `deferred`. See `QueueDeferral`. */
  readonly deferral: QueueDeferral | null;
  readonly priority: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type QueueDeliverableShape = "verdict-only";

export function parseQueueDeliverableShape(value: string): QueueDeliverableShape {
  if (value === "verdict-only") return value;
  throw new Error(
    `invalid deliverable shape "${value}" — the only accepted value is "verdict-only"`,
  );
}

export interface QueueItemSqlRow {
  id: string;
  objective_code: string | null;
  status: string;
  body: string;
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
  deferred_depends_on: string | null;
  deferred_release_authority: string | null;
  deferred_reason: string | null;
  priority: number;
  created_at: number;
  updated_at: number;
  launch_eligible: number;
  launch_alpha_name: string | null;
  launch_target_repo: string | null;
  launch_target_branch: string | null;
  launch_base_commit: string | null;
  pr_branch: string | null;
  model_hint_harness: string | null;
  model_hint_model: string | null;
  deliverable_shape?: string | null;
}

export type QueueDeliveryMirrorVerdict =
  "delivered" | "not-delivered" | "not-started" | "unknown";

export interface QueueDeliveryMirror {
  readonly verdict: QueueDeliveryMirrorVerdict;
  readonly deliveryCommit: string | null;
  readonly targetRepo: string | null;
  readonly targetBranch: string | null;
  readonly treeIdentity: string | null;
  readonly checkedAt: number | null;
  readonly reason: string | null;
}

export interface QueueAbsorption {
  readonly objectiveCode: string;
  readonly deliveryCommit: string | null;
  readonly targetRepo: string | null;
  readonly targetBranch: string | null;
  readonly treeIdentity: string | null;
  readonly checkedAt: number | null;
  readonly reason: string | null;
}

export const queueItemColumns = `id, objective_code, status, body, deferred_depends_on, deferred_release_authority, deferred_reason, launch_eligible, launch_alpha_name, launch_target_repo, launch_target_branch, launch_base_commit, pr_branch, model_hint_harness, model_hint_model, deliverable_shape, agent_name, target_repo, base_commit, delivery_commit, validation_required, validation_required_at, delivery_mirror_state, delivery_mirror_commit, delivery_mirror_repo, delivery_mirror_branch, delivery_mirror_tree_identity, delivery_mirror_checked_at, delivery_mirror_reason, absorption_objective_code, absorption_delivery_commit, absorption_target_repo, absorption_target_branch, absorption_tree_identity, absorption_checked_at, absorption_reason, priority, created_at, updated_at`;

export function isQueueDeliveryMirrorVerdict(
  value: string,
): value is QueueDeliveryMirrorVerdict {
  return (
    value === "delivered" ||
    value === "not-delivered" ||
    value === "not-started" ||
    value === "unknown"
  );
}

export function requireQueueDeliveryMirror(
  mirror: QueueDeliveryMirror,
): QueueDeliveryMirror {
  if (!isQueueDeliveryMirrorVerdict(mirror.verdict)) {
    throw new Error(
      `queue delivery mirror verdict is invalid: ${mirror.verdict}`,
    );
  }
  return mirror;
}

export function requireQueuePriority(priority: number): number {
  if (!Number.isSafeInteger(priority)) {
    throw new Error(`queue priority must be an integer: ${priority}`);
  }
  return priority;
}

export function parseQueuePriority(value: string | undefined): number {
  if (value === undefined || !/^-?\d+$/.test(value)) {
    throw new Error(`queue priority must be an integer: ${value ?? ""}`);
  }
  return requireQueuePriority(Number(value));
}

function launchEligibility(row: QueueItemSqlRow): QueueLaunchEligibility {
  const values = [
    row.objective_code,
    row.launch_alpha_name,
    row.launch_target_repo,
    row.launch_target_branch,
    row.launch_base_commit,
  ];
  if (row.launch_eligible === 0)
    return {
      eligible: false,
      reason: "launch eligibility not marked",
      alphaName: row.launch_alpha_name,
      targetRepo: row.launch_target_repo,
      targetBranch: row.launch_target_branch,
      baseCommit: row.launch_base_commit,
    };
  if (values.some((value) => value === null || value.trim() === ""))
    return {
      eligible: false,
      reason: "launch eligibility metadata incomplete",
      alphaName: row.launch_alpha_name,
      targetRepo: row.launch_target_repo,
      targetBranch: row.launch_target_branch,
      baseCommit: row.launch_base_commit,
    };
  return {
    eligible: true,
    reason: "",
    alphaName: row.launch_alpha_name,
    targetRepo: row.launch_target_repo,
    targetBranch: row.launch_target_branch,
    baseCommit: row.launch_base_commit,
  };
}

/**
 * Why a row is held, and what would release it.
 *
 * `dependsOn` is the machine-checkable half: the objective codes that must all
 * reach a terminal status before this row may launch. The autoscaler evaluates
 * it every tick and releases the row itself, which is the entire point — the
 * hold that prompted this feature stayed shut for hours after its condition
 * was satisfied because nothing was watching.
 *
 * `releaseAuthority` is the half no predicate can evaluate: "the Lord must
 * rule on D6". A row carrying one is never auto-released and never picked up
 * by idle recovery; it waits for the named authority and nothing else. That
 * exemption is narrow on purpose — it is the only way to make a hold that
 * outlasts an idle court, so it must be spelled deliberately rather than
 * fallen into.
 */
export interface QueueDeferral {
  readonly dependsOn: readonly string[];
  readonly releaseAuthority: string | null;
  readonly reason: string | null;
}

/** Parses the stored deferral columns. Returns `null` for any row that is not
 *  deferred, so a stale value left on a released row can never be mistaken for
 *  a live hold. */
export function toQueueDeferral(row: QueueItemSqlRow): QueueDeferral | null {
  if (row.status !== RegentQueueItemStatus.Deferred) return null;
  const dependsOn = (row.deferred_depends_on ?? "")
    .split(",")
    .map((code) => code.trim().toLowerCase())
    .filter((code) => code !== "");
  return {
    dependsOn,
    releaseAuthority: row.deferred_release_authority,
    reason: row.deferred_reason,
  };
}

export function toQueueItemRow(row: QueueItemSqlRow): RegentQueueItemRow {
  const item: RegentQueueItemRow = {
    id: row.id,
    objectiveCode: row.objective_code,
    status: row.status as RegentQueueItemStatus,
    body: row.body,
    prBranch: row.pr_branch,
    modelHint: row.model_hint_harness === null || row.model_hint_model === null ? null : { harness: row.model_hint_harness as ModelPair["harness"], model: row.model_hint_model },
    deliverableShape:
      row.deliverable_shape === "verdict-only" ? "verdict-only" : null,
    agentName: row.agent_name,
    targetRepo: row.target_repo,
    baseCommit: row.base_commit,
    deliveryCommit: row.delivery_commit,
    validationRequired: row.validation_required === 1,
    validationRequiredAt: row.validation_required_at,
    deliveryMirror: {
      verdict: row.delivery_mirror_state as QueueDeliveryMirrorVerdict,
      deliveryCommit: row.delivery_mirror_commit,
      targetRepo: row.delivery_mirror_repo,
      targetBranch: row.delivery_mirror_branch,
      treeIdentity: row.delivery_mirror_tree_identity,
      checkedAt: row.delivery_mirror_checked_at,
      reason: row.delivery_mirror_reason,
    },
    absorption:
      row.absorption_objective_code === null
        ? null
        : {
            objectiveCode: row.absorption_objective_code,
            deliveryCommit: row.absorption_delivery_commit,
            targetRepo: row.absorption_target_repo,
            targetBranch: row.absorption_target_branch,
            treeIdentity: row.absorption_tree_identity,
            checkedAt: row.absorption_checked_at,
            reason: row.absorption_reason,
          },
    deferral: toQueueDeferral(row),
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  Object.defineProperty(item, "launchEligibility", {
    value: launchEligibility(row),
    enumerable: false,
  });
  return item;
}
