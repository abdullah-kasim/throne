import path from 'node:path';
import { realIdentity } from '../git-lifecycle/git-worktree.service.ts';

/**
 * The one canonical "is this path the target directory or something beneath
 * it" predicate for process-inspection callers. It compares REAL filesystem
 * identity, not path strings: this box symlinks `/home` -> `/var/home`, so a
 * `/proc/<pid>/cwd` link target and a worktree path resolved elsewhere can
 * spell the same directory two different ways, and a bare string comparison
 * silently misses the match.
 *
 * `reap-agent/occupancy.ts` keeps its own private `isWithinTree` on purpose:
 * that one answers a question about live *agents* recorded in the herdr
 * roster, this one answers a question about OS processes read out of
 * `/proc`. They share `realIdentity`, which is the part worth sharing.
 */
export function isPathWithin(candidate: string, target: string): boolean {
  const resolvedCandidate = realIdentity(candidate);
  const resolvedTarget = realIdentity(target);
  return (
    resolvedCandidate === resolvedTarget ||
    resolvedCandidate.startsWith(resolvedTarget + path.sep)
  );
}
