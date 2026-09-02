import { realpathSync } from "node:fs";

/**
 * Resolves `candidatePath` through `realpathSync` (which follows symlinks,
 * unlike `path.resolve`) so a dual-spelling mount — e.g. `/home` symlinked
 * to `/var/home` — collapses to one canonical spelling. A path that cannot
 * be resolved (missing, unreadable, ...) falls back to the raw string
 * unchanged rather than throwing: callers use this to normalize a path
 * before comparison/lookup, and a genuinely absent path must behave exactly
 * as it did before resolution was introduced, not crash the caller.
 */
export function resolvedOrRawPath(candidatePath: string): string {
  try {
    return realpathSync(candidatePath);
  } catch {
    return candidatePath;
  }
}

/**
 * True when `a` and `b` denote the same real filesystem path. Byte-identical
 * strings short-circuit without touching the filesystem; otherwise both are
 * resolved through `realpathSync` so a dual-spelling mount — e.g. `/home`
 * symlinked to `/var/home` — never produces a false mismatch between two
 * independently sourced paths for the same directory.
 *
 * A path that cannot be resolved (missing, unreadable, ...) is treated as
 * non-equivalent rather than thrown: every caller of this predicate is an
 * identity/ownership guard where "cannot be proven equivalent" must fail
 * closed as "different," never crash the caller.
 */
export function pathsResolveEqual(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
