import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  branchCheckouts,
  localBranchTip,
  requireAdvancedSinceSpawn,
  requireDurableDefaultRetention,
  requireReachableFromBranch,
  requireReachableFromMergeTarget,
  requireValidLifecycleBranch,
  resolveLifecycleRepo,
} from './branch-authority.ts';
import { requireContentDeliveredToMergeTarget } from './path-wise-delivery.ts';
import { canonicalPath, readGitStatus, runGit } from './git-command.service.ts';
import { shadowTipIsStamped } from './absorb-and-stamp.ts';

export type BranchCleanupPlan =
  | {
      status: 'absent';
      branch: string;
      projectDir: string;
      root: string;
    }
  | {
      status: 'ready';
      branch: string;
      projectDir: string;
      root: string;
      tip: string;
      mergeTargetBranch: string;
      retention:
        | { kind: 'branch'; branch: string }
        | { kind: 'delivery-content'; commit: string }
        | { kind: 'forced-missing-target' };
      worktreePath?: string;
    };

type ReadyBranchCleanupPlan = Extract<
  BranchCleanupPlan,
  { status: 'ready' }
>;

async function requireRemovableCheckout(
  root: string,
  branch: string,
): Promise<string | undefined> {
  const checkouts = await branchCheckouts(root, branch);
  if (checkouts.length > 1) {
    throw new Error(
      `branch "${branch}" is checked out in multiple registered worktrees; ` +
        'remove the foreign checkout before reaping',
    );
  }
  const checkout = checkouts[0];
  if (checkout === undefined) {
    return undefined;
  }

  const [checkoutPath, rootPath] = await Promise.all([
    canonicalPath(checkout.path),
    canonicalPath(root),
  ]);
  if (checkoutPath === rootPath) {
    throw new Error(
      `branch "${branch}" is checked out in the retained target worktree; ` +
        'switch that worktree to the retained target branch before reaping',
    );
  }
  return checkout.path;
}

async function chooseRetentionAuthority(
  root: string,
  branch: string,
  tip: string,
  mergeTargetBranch: string,
  forceMissingMergeTarget: boolean,
  contentDeliveryCommit?: string,
): Promise<ReadyBranchCleanupPlan['retention']> {
  if ((await localBranchTip(root, mergeTargetBranch)) !== undefined) {
    try {
      await requireReachableFromMergeTarget(root, branch, tip, mergeTargetBranch);
      return { kind: 'branch', branch: mergeTargetBranch };
    } catch (error) {
      if (contentDeliveryCommit === undefined) throw error;
      await requireContentDeliveredToMergeTarget(
        root,
        branch,
        tip,
        mergeTargetBranch,
        contentDeliveryCommit,
      );
      return { kind: 'delivery-content', commit: contentDeliveryCommit };
    }
  }
  if (forceMissingMergeTarget) {
    return { kind: 'forced-missing-target' };
  }
  return {
    kind: 'branch',
    branch: await requireDurableDefaultRetention(root, branch, tip),
  };
}

export async function preflightBranchCleanup(
  branch: string,
  projectDir: string,
  mergeTargetBranch: string,
  forceMissingMergeTarget: boolean,
  spawnCommit: string,
  contentDeliveryCommit?: string,
  allowUnadvancedBranch = false,
): Promise<BranchCleanupPlan> {
  const root = await resolveLifecycleRepo(projectDir);
  await requireValidLifecycleBranch(root, branch);

  const tip = await localBranchTip(root, branch);
  if (tip === undefined) {
    return { status: 'absent', branch, projectDir, root };
  }
  if (!allowUnadvancedBranch) {
    await requireAdvancedSinceSpawn(root, branch, tip, spawnCommit);
  }

  const worktreePath = await requireRemovableCheckout(root, branch);
  const retention = await chooseRetentionAuthority(
    root,
    branch,
    tip,
    mergeTargetBranch,
    forceMissingMergeTarget,
    contentDeliveryCommit,
  );
  return {
    status: 'ready',
    branch,
    projectDir,
    root,
    tip,
    mergeTargetBranch,
    retention,
    ...(worktreePath === undefined ? {} : { worktreePath }),
  };
}

async function requireUnchangedCleanupAuthority(
  plan: ReadyBranchCleanupPlan,
): Promise<string | undefined> {
  const tip = await localBranchTip(plan.root, plan.branch);
  if (tip === undefined) {
    return undefined;
  }
  if (tip !== plan.tip) {
    throw new Error(
      `branch "${plan.branch}" moved after cleanup preflight; refusing deletion`,
    );
  }
  if ((await branchCheckouts(plan.root, plan.branch)).length > 0) {
    throw new Error(
      `branch "${plan.branch}" is still checked out in a registered worktree; ` +
        'refusing deletion',
    );
  }
  if (plan.retention.kind === 'delivery-content') {
    await requireContentDeliveredToMergeTarget(
      plan.root,
      plan.branch,
      tip,
      plan.mergeTargetBranch,
      plan.retention.commit,
    );
  } else if (plan.retention.kind === 'branch') {
    if (plan.retention.branch === plan.mergeTargetBranch) {
      await requireReachableFromMergeTarget(
        plan.root,
        plan.branch,
        tip,
        plan.mergeTargetBranch,
      );
    } else {
      await requireReachableFromBranch(
        plan.root,
        plan.branch,
        tip,
        plan.retention.branch,
      );
    }
  }
  return tip;
}

/** A branch about to be deleted may be carrying its own completion stamp as
 *  its tip commit — `absorbAndStamp` publishes `Deliver <branch>` only onto
 *  the branch it stamps, so that branch's own ref is the sole thing keeping
 *  the stamp reachable. Anchors it with a lightweight tag before the branch
 *  ref disappears, so `hasDeliveryCommit`'s `git log --all` still finds it
 *  afterward. A tag, not a second branch or a fast-forward onto some other
 *  branch, because reachability from any ref is all the completion proof
 *  requires, and a tag is the cheapest ref that provides it without moving
 *  or touching any other branch's history. Returns the tag name created, or
 *  `undefined` when `tip` was not itself a stamp — nothing to preserve. */
async function preserveDeliveryStampBeforeDeletion(
  root: string,
  branch: string,
  tip: string,
): Promise<string | undefined> {
  if (!(await shadowTipIsStamped(root, tip, branch))) {
    return undefined;
  }
  const tagName = `preserved-deliver-stamp/${branch}`;
  await runGit(['tag', '--force', tagName, tip], root);
  return tagName;
}

export async function deleteBranchCleanup(
  plan: ReadyBranchCleanupPlan,
): Promise<boolean> {
  const tip = await requireUnchangedCleanupAuthority(plan);
  if (tip === undefined) {
    return false;
  }
  await preserveDeliveryStampBeforeDeletion(plan.root, plan.branch, tip);
  const deleted = await readGitStatus(
    ['branch', '-D', '--', plan.branch],
    plan.root,
  );
  if (deleted.code !== 0) {
    throw new Error(
      `deletion of proven-delivered branch "${plan.branch}" failed: ` +
        `${deleted.stderr.trim() || `git exited ${deleted.code}`}`,
    );
  }
  return true;
}

export async function restoreBranchCleanup(
  plan: ReadyBranchCleanupPlan,
): Promise<void> {
  if ((await localBranchTip(plan.root, plan.branch)) === undefined) {
    await runGit(['branch', plan.branch, plan.tip], plan.root);
  }
  if (plan.worktreePath === undefined) {
    return;
  }
  if ((await branchCheckouts(plan.root, plan.branch)).length > 0) {
    return;
  }
  await mkdir(path.dirname(plan.worktreePath), { recursive: true });
  await runGit(
    ['worktree', 'add', plan.worktreePath, plan.branch],
    plan.root,
  );
}
