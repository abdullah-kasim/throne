import {
  canonicalPath,
  readGitStatus,
  repoRoot,
  runGit,
  type CommandStatus,
} from "./git-command.service.ts";
import {
  GitWorktreeService,
  managedWorktreeRoot,
  type Worktree,
} from "./git-worktree.service.ts";

const WORKTREES = new GitWorktreeService();

export class UnmergedLifecycleBranchError extends Error {}

export class UnobservedMergeBranchError extends UnmergedLifecycleBranchError {}

export function resolveLifecycleRepo(projectDir: string): Promise<string> {
  return repoRoot(projectDir);
}

export async function requireValidLifecycleBranch(
  root: string,
  branch: string,
): Promise<void> {
  const valid = await readGitStatus(
    ["check-ref-format", "--branch", branch],
    root,
  );
  if (valid.code !== 0) {
    throw new Error(
      `recorded lifecycle branch "${branch}" is not a valid branch name`,
    );
  }
}

export async function localBranchTip(
  root: string,
  branch: string,
): Promise<string | undefined> {
  const ref = `refs/heads/${branch}`;
  const result = await readGitStatus(
    ["show-ref", "--verify", "--quiet", ref],
    root,
  );
  if (result.code === 1) return undefined;
  if (result.code !== 0) {
    throw new Error(
      `cannot inspect branch "${branch}": ` +
        `${result.stderr.trim() || `git exited ${result.code}`}`,
    );
  }
  return runGit(["rev-parse", ref], root);
}

export async function requiredMergeTargetTip(
  root: string,
  branch: string,
  mergeTargetBranch: string,
): Promise<string> {
  const targetTip = await localBranchTip(root, mergeTargetBranch);
  if (targetTip === undefined) {
    throw new Error(
      `recorded merge-target branch "${mergeTargetBranch}" for branch ` +
        `"${branch}" does not exist in the target repo ` +
        `(refs/heads/${mergeTargetBranch} is absent); re-create that branch ` +
        "or fix the recorded provenance before teardown",
    );
  }
  return targetTip;
}

/** The newest commit `a` and `b` share. */
export async function mergeBaseRevision(
  root: string,
  a: string,
  b: string,
): Promise<string> {
  return runGit(["merge-base", a, b], root);
}

export async function readReachability(
  root: string,
  tip: string,
  retainingTip: string,
): Promise<CommandStatus> {
  return readGitStatus(
    ["merge-base", "--is-ancestor", tip, retainingTip],
    root,
  );
}

/**
 * Resolve the lowest ancestor of `tip` reached by stripping a trailing run
 * of content-empty commits — a single-parent commit whose tree is identical
 * to its sole parent's. Stops at, and returns, the first commit in the walk
 * that either changes tree content relative to its parent, or has zero
 * parents (a root commit) or more than one parent (a merge commit): neither
 * is ever itself stripped, even when content-identical to one parent, and
 * the walk never descends INTO a merge to decide whether to strip it — only
 * a linear run of no-op commits sitting on top of one is stripped.
 *
 * Exists because a branch's real work can be pushed arbitrarily far past its
 * true delivery point by a trailing commit whose tree never actually
 * changed (e.g. a completion-stamp commit) — comparing the raw, live tip
 * against a target then wrongly treats "the branch moved" as "the branch's
 * content moved." Callers that ask "is this branch's WORK reachable from a
 * target" should compare `contentTip(tip)`, not `tip`, against the target.
 * Callers that ask "did this branch merely advance past its spawn point"
 * (`requireAdvancedSinceSpawn`) must NOT use this — a content-empty stamp
 * commit correctly answers "yes, it advanced," and stripping it back to the
 * spawn commit would break that check.
 */
export async function contentTip(root: string, tip: string): Promise<string> {
  let current = tip;
  for (;;) {
    const parentsLine = await runGit(
      ["rev-list", "--parents", "-n", "1", current],
      root,
    );
    const parents = parentsLine.trim().split(/\s+/).slice(1);
    if (parents.length !== 1) return current;
    const parent = parents[0]!;
    const diff = await readGitStatus(
      ["diff", "--quiet", parent, current, "--", "."],
      root,
    );
    if (diff.code === 1) return current;
    if (diff.code !== 0) {
      throw new Error(
        `cannot compare tree content of "${current}" against its parent "${parent}": ` +
          `${diff.stderr.trim() || `git exited ${diff.code}`}`,
      );
    }
    current = parent;
  }
}

export async function requireAdvancedSinceSpawn(
  root: string,
  branch: string,
  tip: string,
  spawnCommit: string,
): Promise<void> {
  if (tip !== spawnCommit) return;
  throw new UnobservedMergeBranchError(
    `branch "${branch}" has no commits beyond its recorded spawn commit ` +
      `${spawnCommit} — it was never observed to advance, so it cannot be ` +
      "proven merged even though it is trivially an ancestor of every " +
      "target; refusing deletion. If the agent reported DONE, its work " +
      "never landed — investigate before forcing.",
  );
}

export async function requireReachableFromMergeTarget(
  root: string,
  branch: string,
  tip: string,
  mergeTargetBranch: string,
): Promise<void> {
  const targetTip = await requiredMergeTargetTip(
    root,
    branch,
    mergeTargetBranch,
  );
  // Compare the branch's CONTENT tip, not its raw live tip: a trailing
  // content-empty commit (e.g. a completion stamp) can push the raw tip
  // past a target it never actually diverged from, wrongly reporting
  // unmerged work that in fact already landed.
  const reachabilityTip = await contentTip(root, tip);
  const result = await readReachability(root, reachabilityTip, targetTip);
  if (result.code === 0) return;
  if (result.code === 1) {
    throw new UnmergedLifecycleBranchError(
      `branch "${branch}" contains commits not reachable from its recorded ` +
        `merge-target branch "${mergeTargetBranch}". This means either the ` +
        "branch carries unlanded work, or it was delivered by a history-" +
        "rewrite transplant that landed its content without ever making " +
        `it an ancestor of "${mergeTargetBranch}". Do not merge it into ` +
        `"${mergeTargetBranch}" to satisfy this check — for a transplant ` +
        "delivery that would reintroduce content the transplant was used " +
        `to avoid landing. If the content is confirmed already landed on ` +
        `"${mergeTargetBranch}", rerun with --force to complete teardown ` +
        "while preserving this branch as a recovery ref; if the branch " +
        "carries genuine unlanded unique work, rerun with " +
        "--archive-cancelled-unmerged to preserve it under cancelled " +
        "provenance instead.",
    );
  }
  throw new Error(
    `cannot prove branch "${branch}" is reachable from its recorded ` +
      `merge-target branch "${mergeTargetBranch}": ` +
      `${result.stderr.trim() || `git exited ${result.code}`}`,
  );
}

async function durableDefaultBranch(root: string): Promise<string> {
  const remoteHeadRef = "refs/remotes/origin/HEAD";
  const result = await readGitStatus(
    ["symbolic-ref", "--quiet", "--short", remoteHeadRef],
    root,
  );
  const symbolic = result.stdout.trim();
  if (result.code !== 0 || symbolic.length === 0) {
    throw new Error(
      `cannot resolve the target repo's durable default branch: ` +
        `${remoteHeadRef} is unset or not a symbolic ref ` +
        `(${result.stderr.trim() || `git exited ${result.code}`}); set it with ` +
        "`git remote set-head origin --auto` before teardown",
    );
  }
  const prefix = "origin/";
  const name = symbolic.startsWith(prefix) ? symbolic.slice(prefix.length) : "";
  if (name.length === 0) {
    throw new Error(
      `cannot resolve the target repo's durable default branch: ` +
        `${remoteHeadRef} points at "${symbolic}", which does not name an ` +
        "origin branch; repair that symbolic ref before teardown",
    );
  }
  if ((await localBranchTip(root, name)) === undefined) {
    throw new Error(
      `the target repo's durable default branch "${name}" ` +
        `(from ${remoteHeadRef}) has no local refs/heads/${name}; ` +
        "create that local branch before teardown",
    );
  }
  return name;
}

export async function requireReachableFromBranch(
  root: string,
  branch: string,
  tip: string,
  retainingBranch: string,
): Promise<void> {
  const retainingTip = await localBranchTip(root, retainingBranch);
  if (retainingTip === undefined) {
    throw new Error(
      `retaining branch "${retainingBranch}" for lifecycle branch ` +
        `"${branch}" does not exist in the target repo`,
    );
  }
  const result = await readReachability(root, tip, retainingTip);
  if (result.code === 0) return;
  if (result.code === 1) {
    throw new UnmergedLifecycleBranchError(
      `branch "${branch}" is not retained by the target repo's durable ` +
        `default branch "${retainingBranch}" after its recorded merge-target ` +
        "branch vanished",
    );
  }
  throw new Error(
    `cannot prove branch "${branch}" is retained by the target repo's ` +
      `durable default branch "${retainingBranch}": ` +
      `${result.stderr.trim() || `git exited ${result.code}`}`,
  );
}

export async function requireDurableDefaultRetention(
  root: string,
  branch: string,
  tip: string,
): Promise<string> {
  const defaultBranch = await durableDefaultBranch(root);
  await requireReachableFromBranch(root, branch, tip, defaultBranch);
  return defaultBranch;
}

export async function requireNotReachableFromMergeTarget(
  root: string,
  branch: string,
  tip: string,
  mergeTargetBranch: string,
): Promise<void> {
  const targetTip = await requiredMergeTargetTip(
    root,
    branch,
    mergeTargetBranch,
  );
  const result = await readReachability(root, tip, targetTip);
  if (result.code === 1) return;
  if (result.code === 0) {
    throw new Error(
      `branch "${branch}" is already reachable from its recorded merge-target ` +
        `branch "${mergeTargetBranch}"; cancelled-unmerged archival requires ` +
        "an intentionally unmerged branch",
    );
  }
  throw new Error(
    `cannot prove branch "${branch}" is not reachable from its recorded ` +
      `merge-target branch "${mergeTargetBranch}": ` +
      `${result.stderr.trim() || `git exited ${result.code}`}`,
  );
}

export async function branchCheckouts(
  root: string,
  branch: string,
): Promise<Worktree[]> {
  return (await WORKTREES.list(root)).filter(
    (worktree) => worktree.branch === branch,
  );
}

export async function dedicatedWorktreePath(
  root: string,
  branch: string,
): Promise<string> {
  return managedWorktreeRoot(await canonicalPath(root), branch);
}
