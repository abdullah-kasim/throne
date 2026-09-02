import os from 'node:os';
import path from 'node:path';
import { isPathWithin } from '../process-inspection/path-containment.ts';
import { worktreesHome } from '../git-lifecycle/git-worktree.service.ts';
import { resolveWorktreeOwnerName } from '../process-inspection/worktree-owner.ts';

export type ReapSafetyClass = 'reap-safe' | 'report-and-investigate';

export interface OwnershipVerdict {
  reapSafety: ReapSafetyClass;
  /** The agent whose worktree this process is working inside, when its cwd
   *  resolves to one. */
  worktreeOwner?: string;
  /** True only when `worktreeOwner` is set AND that agent is neither live in
   *  the herdr roster nor a registered agent -- i.e. an orphan whose owner no
   *  longer exists. Reported, never killed by this sweep. */
  orphaned: boolean;
}

export interface OwnershipInputs {
  cwd: string | undefined;
  liveAgentNames: ReadonlySet<string>;
  registeredAgentNames: ReadonlySet<string>;
  home?: string;
  worktreesRoot?: string;
}

/**
 * The Lord's reap-safety classification, by cwd: work directories under
 * `~/repos/*`, `~/dotfiles`, and `~/.throne/worktrees/` are the reap-safe
 * class; everything else is report-and-investigate. This function is only
 * ever reached for processes that already survived the never-touch filter
 * (`never-touch.ts`) -- calling it first would classify `throne-backend`
 * itself as reap-safe, since its own `WorkingDirectory=` is inside
 * `~/repos/throne`.
 *
 * A process with no readable cwd is `report-and-investigate`: an unknown
 * working directory is not evidence of safety.
 */
export function classifyOwnership(inputs: OwnershipInputs): OwnershipVerdict {
  const home = inputs.home ?? os.homedir();
  const worktreesRoot = inputs.worktreesRoot ?? worktreesHome();
  const cwd = inputs.cwd;
  if (cwd === undefined || cwd.length === 0) {
    return { reapSafety: 'report-and-investigate', orphaned: false };
  }
  const owner = resolveWorktreeOwnerName(cwd, worktreesRoot);
  const reapSafeRoots = [path.join(home, 'repos'), path.join(home, 'dotfiles'), worktreesRoot];
  const reapSafety: ReapSafetyClass = reapSafeRoots.some((root) => isPathWithin(cwd, root))
    ? 'reap-safe'
    : 'report-and-investigate';
  if (owner === undefined) return { reapSafety, orphaned: false };
  return {
    reapSafety,
    worktreeOwner: owner,
    orphaned: !inputs.liveAgentNames.has(owner) && !inputs.registeredAgentNames.has(owner),
  };
}
