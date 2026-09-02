/**
 * The exact, forward-only transform the harness itself uses to name a
 * session scratchpad directory from an agent's cwd: every character that
 * is not `[A-Za-z0-9]` becomes `-`, one for one, with no collapsing of
 * adjacent separators (so `/var/home/theuser/.throne/...` and its literal `-`s
 * are both individually replaced, producing the double-hyphen seams
 * observed on disk). This module only ever runs the transform FORWARD —
 * from a known candidate path to its expected slug — and compares by exact
 * string equality; it never attempts to invert a slug back into a path,
 * which would be ambiguous by construction (agent names themselves contain
 * hyphens indistinguishable from transformed separators).
 */
export function slugifyPath(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * True when `entryName` is the forward slug of a path under `worktreesHome`
 * — i.e. it is worktree-shaped and a candidate for name attribution at all,
 * independent of whether any known repo name completes the match.
 */
export function looksWorktreeHomeShaped(entryName: string, worktreesHome: string): boolean {
  return entryName.startsWith(`${slugifyPath(worktreesHome)}-`);
}

const NESTED_SCRATCHPAD_SEGMENT = "scratchpad";

/**
 * True when `remainder` — the text left after stripping `<worktreesHome>-
 * <repoName>-` off an entry name — still looks like it encodes ANOTHER
 * worktree-shaped path rather than a bare agent name: either it re-embeds
 * the worktrees-home slug (a worktree path nested inside a worktree path),
 * or it contains the harness's own reserved `scratchpad` path segment (the
 * fixed subfolder every session scratchpad lives under), which only
 * appears when a second agent's cwd was resolved to a path INSIDE another
 * agent's scratchpad. Neither shape is a bare agent name, so the caller
 * must treat it as unresolved rather than guess.
 */
function looksLikeNestedScratchpadRemainder(remainder: string, worktreesHome: string): boolean {
  if (remainder.includes(slugifyPath(worktreesHome))) return true;
  return remainder.split("-").includes(NESTED_SCRATCHPAD_SEGMENT);
}

/**
 * The exactly-one throne agent name a `/tmp/claude-1000` entry name
 * positively attributes to, or `undefined` when it does not resolve. A
 * candidate resolves only when the entry name is the FORWARD slug of
 * `<worktreesHome>/<repoName>/<agentName>` for exactly one `repoName` in
 * `repoNames` — computed by slugifying each known repo path and checking an
 * exact prefix match, never by guessing where separators were in the
 * original path. If two different repo names each produce a prefix match
 * that yields a different remaining agent name, the entry is ambiguous by
 * construction and this returns `undefined` — deny by default, never a
 * guess between them. A remainder that still looks worktree-slug-shaped
 * (see `looksLikeNestedScratchpadRemainder`) is likewise excluded rather
 * than misattributed to the outer agent name it happens to start with.
 */
export function resolveAgentNameCandidate(
  entryName: string,
  worktreesHome: string,
  repoNames: readonly string[],
): string | undefined {
  if (!looksWorktreeHomeShaped(entryName, worktreesHome)) return undefined;
  const homePrefix = `${slugifyPath(worktreesHome)}-`;
  const afterHome = entryName.slice(homePrefix.length);

  const candidates = new Set<string>();
  for (const repoName of repoNames) {
    const repoPrefix = `${slugifyPath(repoName)}-`;
    if (!afterHome.startsWith(repoPrefix)) continue;
    const agentName = afterHome.slice(repoPrefix.length);
    if (agentName.length === 0) continue;
    if (looksLikeNestedScratchpadRemainder(agentName, worktreesHome)) continue;
    candidates.add(agentName);
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

/**
 * The repo directory names positive attribution is allowed to consider —
 * every top-level directory under `worktreesRoot`, read once per run. A
 * read failure (root missing, unreadable) yields an empty list, which makes
 * every candidate fail the prefix match above and fall through to
 * `UNKNOWN` — never a reason to widen matching.
 */
export async function readKnownRepoNames(
  worktreesRoot: string,
  readdir: (dirPath: string) => Promise<{ name: string; isDirectory(): boolean }[]>,
): Promise<string[]> {
  try {
    const entries = await readdir(worktreesRoot);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
