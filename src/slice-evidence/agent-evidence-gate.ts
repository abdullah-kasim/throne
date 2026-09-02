/** The verdict shape shared by the three machine-checked reap preconditions.
 *  Previously defined alongside the stated-evidence matcher; that module was
 *  deleted on the Lord's order (see `checkAgentEvidenceRequirementByName`) and
 *  the type moved here, to its only remaining consumer. */
export interface SliceEvidenceResult {
  ok: boolean;
  /** Present only on failure: which piece is missing. */
  reason?:
    | "delivery-not-proven"
    | "own-worktree-dirty"
    | "runtime-model-unverified";
  /** The exact command extracted from the slice's "Evidence required:" line. */
  command?: string;
  /** Present only for a machine-checked precondition failure: the specific,
   *  never-generic explanation and preserved evidence location. */
  detail?: string;
  /** Present only on `ok: true` from `checkOwnWorktreeCommittedPrecondition`
   *  or `checkTerminalDeliveryPrecondition`: which exempt/checked outcome
   *  fired. Keeps "genuinely checked and clean/delivered" distinguishable
   *  from each legitimate skip reason — a bug that always exempts can never
   *  masquerade as "checked" this way. */
  outcome?:
    | "clean"
    | "exempt-verdict-only"
    | "exempt-terminal-delivery"
    | "exempt-no-tree-base"
    | "exempt-verdict-only-supervisor";
}

import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import {
  DEFAULT_DATA_DIR,
  fileExists,
} from "../agentdata/ledger-data.service.ts";
import {
  readAgentSupervisor,
  IdentityLineReadStatus,
} from "../agentdata/identity-data.service.ts";
import { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { TREE_BASE_DATA } from "../agentdata/tree-base-data.service.ts";
import { isTerminalDeliveryShadowName } from "../merge-git-tree/terminal-gate-shadow.ts";
import { checkDeliveryVerdict } from "../verify-delivery/verify-delivery-runtime.ts";
import { readGitStatus } from "../git-lifecycle/git-command.service.ts";
import {
  checkAgentRuntimeModelAcceptance,
  type RuntimeModelAcceptance,
} from "../session/runtime-model-acceptance.ts";

const ASSIGNMENT_FILE_NAME = "ASSIGNMENT.md";
const REPORT_FILE_NAME = "REPORT.md";

async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/** REPORT.md lives either directly under the agent's ledger directory or one
 *  level of subdirectory beneath it — the same convention `listCompletedAgents`
 *  already reads (see `hasCompletionReport` in `ledger-data.service.ts`). */
async function findReportText(
  agentDirPath: string,
): Promise<string | undefined> {
  const topLevel = await readTextFile(
    path.join(agentDirPath, REPORT_FILE_NAME),
  );
  if (topLevel !== undefined) return topLevel;

  let subEntries;
  try {
    subEntries = await readdir(agentDirPath, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const subEntry of subEntries) {
    if (!subEntry.isDirectory()) continue;
    const candidate = path.join(agentDirPath, subEntry.name, REPORT_FILE_NAME);
    if (await fileExists(candidate)) return readTextFile(candidate);
  }
  return undefined;
}

export interface AgentEvidenceFiles {
  /** Undefined when the agent has no ASSIGNMENT.md (e.g. an Alpha, which is
   *  never spawned with one) — there is then nothing for this gate to check. */
  assignmentText: string | undefined;
  reportText: string | undefined;
}

/** Reads the two durable files this gate decides against, at the
 *  deterministic paths every Shadow's ledger directory already uses. */
export async function readAgentEvidenceFiles(
  name: string,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<AgentEvidenceFiles> {
  const agentDirPath = path.join(baseDir, name);
  const [assignmentText, reportText] = await Promise.all([
    readTextFile(path.join(agentDirPath, ASSIGNMENT_FILE_NAME)),
    findReportText(agentDirPath),
  ]);
  return { assignmentText, reportText };
}

/**
 * The machine-checked delivery precondition for a 99e-shaped Shadow: PASS is
 * never taken on the Shadow's own say-so. `name` not 99e-shaped — nothing to
 * check, `ok: true`. Otherwise this independently re-derives the supervising
 * Alpha's delivered/not-delivered verdict through the shared
 * `checkDeliveryVerdict` proof `verify-delivery` exposes: every
 * campaign-touched blob remains delivered, or a target divergence on that
 * path is provably later than delivery.
 * regardless of what prose landed in the Shadow's own REPORT.md. A Shadow
 * that never ran `merge-git-tree` (only `absorb-git-tree`, which moves the
 * TARGET into the candidate — the opposite direction) fails this even if its
 * report claims `**Delivery outcome:** PASS`, because the re-derived delivery
 * verdict itself, not the claim, is what gates completion.
 *
 * The supervising Alpha's own `deliverable_shape` is consulted first: a
 * `"verdict-only"` Alpha never produces a git-shaped delivery by design, so
 * `checkDeliveryVerdict` would find no recorded provenance and refuse
 * vacuously — the same exemption `checkOwnWorktreeCommittedPrecondition`
 * already grants its own agent, applied here to the supervisor whose
 * deliverable this precondition actually re-derives.
 */
export async function checkTerminalDeliveryPrecondition(
  name: string,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<SliceEvidenceResult> {
  if (!isTerminalDeliveryShadowName(name)) return { ok: true };

  // A field-genuinely-absent supervisor and an unresolved read both refuse
  // this precondition, matching noop-exemptions.ts's own tristate handling:
  // "no confirmed supervisor" is already the safe, non-destructive refusal,
  // so both outcomes share it rather than re-deriving a fourth answer to the
  // same question.
  const supervisorRead = await readAgentSupervisor(name, baseDir);
  if (supervisorRead.status !== IdentityLineReadStatus.Found) {
    return {
      ok: false,
      reason: "delivery-not-proven",
      detail:
        `"${name}" has no recorded supervisor (identity.md missing or ` +
        "unreadable) — cannot determine which campaign branch to verify.",
    };
  }
  const supervisor = supervisorRead.value;

  const supervisorSpawnSpec = await readSpawnSpec(supervisor, baseDir);
  if (supervisorSpawnSpec?.deliverable_shape === "verdict-only") {
    return { ok: true, outcome: "exempt-verdict-only-supervisor" };
  }

  const verdict = await checkDeliveryVerdict(supervisor, baseDir);
  if (verdict.status === "delivered") return { ok: true };

  const detail =
    verdict.status === "missing-provenance"
      ? `"${supervisor}" has no usable recorded delivery provenance ` +
        `(missing ${verdict.missingFields})`
      : verdict.status === "branch-absent"
        ? `branch "${supervisor}" does not exist`
        : verdict.reason;
  return {
    ok: false,
    reason: "delivery-not-proven",
    detail: `verify-delivery "${supervisor}" did not report DELIVERED (${detail})`,
  };
}

/**
 * Refuses an agent whose own recorded worktree still carries uncommitted
 * TRACKED changes — the "commit before report" gate. Untracked debris
 * (scratch notes, probe scripts, a stray `node_modules`) never triggers
 * this: a Shadow that committed every real line and left litter behind is
 * not the defect this exists to catch.
 *
 * Runs unconditionally except for three legitimate-dirty-tree exemptions,
 * each its own distinguishable `ok: true` outcome so "exempt" can never be
 * mistaken for "checked and clean" later:
 * - `deliverable_shape: "verdict-only"` (spawn.json) — a verdict gate
 *   produces no diff by design.
 * - `isTerminalDeliveryShadowName` (99e) — its own branch is never expected
 *   to carry unique commits; its content lands via its supervising Alpha.
 * - No resolvable `spawn.json` cwd or `tree-base.json` branch for this
 *   agent — nothing to check against.
 *
 * Otherwise reads `git status --porcelain --untracked-files=no` in the
 * agent's own worktree (read-only — never stages, commits, or mutates it).
 * A non-empty result refuses with a `detail` naming the concrete commit
 * remedy and the agent's own branch.
 */
export async function checkOwnWorktreeCommittedPrecondition(
  name: string,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<SliceEvidenceResult> {
  const spawnSpec = await readSpawnSpec(name, baseDir);
  if (spawnSpec?.deliverable_shape === "verdict-only") {
    return { ok: true, outcome: "exempt-verdict-only" };
  }
  if (isTerminalDeliveryShadowName(name)) {
    return { ok: true, outcome: "exempt-terminal-delivery" };
  }

  const treeBase = await TREE_BASE_DATA.read(name, baseDir);
  const worktreePath = spawnSpec?.cwd;
  if (worktreePath === undefined || treeBase?.branch === undefined) {
    return { ok: true, outcome: "exempt-no-tree-base" };
  }

  const status = await readGitStatus(
    ["status", "--porcelain", "--untracked-files=no"],
    worktreePath,
  );
  if (status.code !== 0) {
    // The recorded cwd is not a readable git worktree (deleted, reaped,
    // never a repo) — same "nothing to check" outcome as no tree-base at
    // all, not a silent pass-through of "checked and clean".
    return { ok: true, outcome: "exempt-no-tree-base" };
  }
  if (status.stdout.trim() === "") {
    return { ok: true, outcome: "clean" };
  }

  return {
    ok: false,
    reason: "own-worktree-dirty",
    detail:
      `"${name}"'s own worktree at ${worktreePath} has uncommitted ` +
      `tracked changes — commit them first (\`git add -A && git commit\`), ` +
      `then re-report; its branch is "${treeBase.branch}".`,
  };
}

/**
 * The single production entrypoint both `complete-agent` and `reap-agent`
 * inject as their `checkEvidenceRequirement` dependency. Three machine-checked
 * preconditions, all of which must hold: the agent's observed runtime model is
 * verified, its delivery is proven by git state, and its own worktree carries
 * no uncommitted tracked changes.
 *
 * THE STATED-EVIDENCE CHECK WAS REMOVED ON THE LORD'S ORDER, 2026-08-25.
 *
 * It read an agent's ASSIGNMENT.md for an `Evidence required:` line and
 * demanded REPORT.md quote that exact command with real output beneath it. It
 * was self-imposed — the court built it on itself after five recorded cases of
 * a stated requirement being trusted unverified — and it was never asked for.
 *
 * It was deleted rather than repaired because it had a demonstrated
 * false-failure rate and no demonstrated catch. A regex bug captured the
 * markdown backticks around the required command, making the check
 * unsatisfiable for any assignment written in the ordinary form; the only
 * report that could satisfy it was a double-backticked one nobody writes. That
 * produced a LOUD FAILURE against an agent with 43 passing tests whose evidence
 * was genuinely present, and — because a plain reap then refuses — it routed
 * operators onto `--reason completed --force`, which cascades teardown through
 * live children. A guard steering the court toward its most destructive flag,
 * to clean up after workers who did nothing wrong, costs more than the claims
 * it was built to catch.
 *
 * WHAT STILL PROTECTS AGAINST A FALSE COMPLETION CLAIM, and it is most of it:
 * delivery is proven from git rather than from prose, which is what refused a
 * teardown on 2026-08-25 for a campaign reporting complete with seven commits
 * and 413 lines of evidence unlanded on its own branch. The dirty-worktree
 * check, the reapability claim, and the terminal gate chain are all unaffected.
 *
 * WHAT IS GENUINELY NO LONGER COVERED, stated plainly rather than buried: a
 * deliverable git cannot see. On a documentation or analysis task the report IS
 * the artefact, so there is no commit to re-derive a verdict from, and nothing
 * mechanical now reads what the agent wrote about itself. That exposure is
 * accepted deliberately, not overlooked.
 */
export async function checkAgentEvidenceRequirementByName(
  name: string,
  baseDir: string = DEFAULT_DATA_DIR,
  checkRuntimeModel: (
    name: string,
    phase: "verdict",
    baseDir: string,
  ) => Promise<RuntimeModelAcceptance> = checkAgentRuntimeModelAcceptance,
): Promise<SliceEvidenceResult> {
  const runtimeModel = await checkRuntimeModel(name, "verdict", baseDir);
  if (!runtimeModel.ok) {
    return {
      ok: false,
      reason: "runtime-model-unverified",
      detail: runtimeModel.detail,
    };
  }
  const delivery = await checkTerminalDeliveryPrecondition(name, baseDir);
  if (!delivery.ok) return delivery;
  return checkOwnWorktreeCommittedPrecondition(name, baseDir);
}

const UNMET_EVIDENCE_REASON_TEXT: Record<
  NonNullable<SliceEvidenceResult["reason"]>,
  string
> = {
  "delivery-not-proven": "delivery is not proven by git state",
  "own-worktree-dirty": "its own worktree has uncommitted tracked changes",
  "runtime-model-unverified": "its observed runtime model is not verified",
};

/** The single message shape both `complete-agent` and `reap-agent --reason
 *  completed` (no `--force`) show when refusing on an unmet stated evidence
 *  requirement, or an unmet machine-checked delivery precondition (a
 *  99e-shaped Shadow whose supervising Alpha does not — right now,
 *  independently re-checked — have a delivered path-wise blob verdict). */
export function describeUnmetEvidenceRefusal(
  name: string,
  result: SliceEvidenceResult,
): string {
  if (result.reason === "delivery-not-proven") {
    return (
      `"${name}" is a delivery-gate Shadow, but ${result.detail} — refusing. ` +
      "(A 99e verdict is never taken on the report's own say-so; the " +
      "shared path-wise blob delivery proof must hold at completion time.)"
    );
  }
  if (result.reason === "own-worktree-dirty") {
    return `${result.detail} — refusing. (Commit before report survives a crash mid-verify; a report cannot substitute for it.)`;
  }
  if (result.reason === "runtime-model-unverified") {
    return (
      `"${name}" has no matching observed-runtime-model attestation: ` +
      `${result.detail} — refusing verdict acceptance. (Launch intent in ` +
      "spawn.json cannot prove which model produced the verdict.)"
    );
  }
  const reasonText = UNMET_EVIDENCE_REASON_TEXT[result.reason!];
  return (
    `"${name}" states "Evidence required: ${result.command}" in its ` +
    `ASSIGNMENT.md, but ${reasonText} — refusing. (The evidence must land ` +
    "as a durable file before completion, not be remembered by the author.)"
  );
}

/** The loud warning `reap-agent --force` prints instead of silently skipping
 *  an unmet stated evidence requirement — force still tears the agent down,
 *  but the skip must be visible. */
export function describeUnmetEvidenceForceSkip(
  name: string,
  result: SliceEvidenceResult,
): string {
  if (result.reason === "delivery-not-proven") {
    return (
      `"${name}" is a delivery-gate Shadow, but ${result.detail} — --force is ` +
      "skipping the shared path-wise blob delivery proof and tearing it down anyway. If its " +
      "supervising Alpha's work is not actually on the target branch, this is " +
      "the exact silent-loss shape --force must never be used to paper over " +
      "without checking main yourself first."
    );
  }
  if (result.reason === "own-worktree-dirty") {
    return (
      `${result.detail} --force is skipping this and tearing it down anyway. ` +
      "If its own worktree carries real, uncommitted work, this is exactly " +
      "the silent-loss shape --force must never be used to paper over " +
      "without checking the worktree yourself first."
    );
  }
  if (result.reason === "runtime-model-unverified") {
    return (
      `"${name}" has no matching observed-runtime-model attestation: ` +
      `${result.detail} --force is skipping the runtime-model quarantine ` +
      "and discarding its preserved evidence."
    );
  }
  const reasonText = UNMET_EVIDENCE_REASON_TEXT[result.reason!];
  return (
    `"${name}" states "Evidence required: ${result.command}" in its ` +
    `ASSIGNMENT.md, but ${reasonText} — --force is skipping this check and ` +
    "tearing it down anyway."
  );
}
