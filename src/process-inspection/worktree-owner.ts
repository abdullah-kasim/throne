import { treeNameFromPath, worktreesHome } from '../git-lifecycle/git-worktree.service.ts';

/**
 * The agent/branch name that owns the worktree containing `candidatePath`,
 * or `undefined` when it does not resolve under
 * `worktreesHome()/<repo-basename>/<name>` -- the same convention
 * `treeNameFromPath` already applies to live-agent occupancy resolution, so
 * the reaper and the detector agree on what "owned by an agent" means
 * instead of each inventing a path convention.
 */
export function resolveWorktreeOwnerName(
  candidatePath: string,
  home: string = worktreesHome(),
): string | undefined {
  return treeNameFromPath(candidatePath, home);
}
