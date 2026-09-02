import {
  branchCheckouts,
  dedicatedWorktreePath,
  localBranchTip,
  requireNotReachableFromMergeTarget,
  requireValidLifecycleBranch,
  resolveLifecycleRepo,
} from './branch-authority.ts';
import { canonicalPath } from './git-command.service.ts';

export interface CancelledUnmergedBranchPlan {
  branch: string;
  ref: string;
  projectDir: string;
  root: string;
  tip: string;
  mergeTargetBranch: string;
  worktreePath?: string;
}

async function requireDedicatedCheckout(
  root: string,
  branch: string,
): Promise<string | undefined> {
  const checkouts = await branchCheckouts(root, branch);
  if (checkouts.length > 1) {
    throw new Error(
      `branch "${branch}" is checked out in multiple registered worktrees; ` +
        'refusing cancelled-unmerged teardown',
    );
  }
  const checkout = checkouts[0];
  if (checkout === undefined) {
    return undefined;
  }

  const [checkoutPath, expectedPath] = await Promise.all([
    canonicalPath(checkout.path),
    dedicatedWorktreePath(root, branch).then(canonicalPath),
  ]);
  if (checkoutPath !== expectedPath) {
    throw new Error(
      `branch "${branch}" is checked out at "${checkout.path}", not its ` +
        `dedicated managed worktree "${expectedPath}"; refusing teardown`,
    );
  }
  return checkout.path;
}

export async function preflightCancelledUnmergedBranch(
  branch: string,
  projectDir: string,
  mergeTargetBranch: string,
): Promise<CancelledUnmergedBranchPlan> {
  const root = await resolveLifecycleRepo(projectDir);
  await requireValidLifecycleBranch(root, branch);

  const ref = `refs/heads/${branch}`;
  const tip = await localBranchTip(root, branch);
  if (tip === undefined) {
    throw new Error(
      `cancelled-unmerged lifecycle ref "${ref}" is absent; refusing teardown`,
    );
  }
  if (!/^[0-9a-f]{40,64}$/u.test(tip)) {
    throw new Error(
      `cancelled-unmerged lifecycle ref "${ref}" did not resolve to a full object ID`,
    );
  }

  const worktreePath = await requireDedicatedCheckout(root, branch);
  await requireNotReachableFromMergeTarget(
    root,
    branch,
    tip,
    mergeTargetBranch,
  );
  return {
    branch,
    ref,
    projectDir,
    root,
    tip,
    mergeTargetBranch,
    ...(worktreePath === undefined ? {} : { worktreePath }),
  };
}

export async function verifyCancelledUnmergedBranch(
  plan: CancelledUnmergedBranchPlan,
): Promise<void> {
  const tip = await localBranchTip(plan.root, plan.branch);
  if (tip === undefined) {
    throw new Error(
      `cancelled-unmerged lifecycle ref "${plan.ref}" vanished after preflight`,
    );
  }
  if (tip !== plan.tip) {
    throw new Error(
      `cancelled-unmerged lifecycle ref "${plan.ref}" moved after preflight; ` +
        'refusing to archive its ledger',
    );
  }
  if ((await branchCheckouts(plan.root, plan.branch)).length > 0) {
    throw new Error(
      `cancelled-unmerged lifecycle ref "${plan.ref}" remains checked out after ` +
        'dedicated worktree removal',
    );
  }
  await requireNotReachableFromMergeTarget(
    plan.root,
    plan.branch,
    tip,
    plan.mergeTargetBranch,
  );
}
