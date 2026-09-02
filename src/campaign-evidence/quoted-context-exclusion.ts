/**
 * Reusable regex-building technique for a diff-text "banned marker" scan that
 * must not fire when the marker only appears as PROSE ABOUT the thing it
 * names — a JSDoc/comment line describing an invariant ("the handler never
 * calls `process.cwd()`"), not a real call site.
 *
 * A bare grep for a literal or pattern cannot tell a call site from a comment
 * documenting that call site's absence: both contain the same substring. This
 * repo already solved that once for `GRAVEYARD_MARKER_PATTERN` (see
 * `campaign-manifest-scan.ts`) by excluding matches immediately preceded by a
 * backtick, single-quote, pipe, or slash — the characters that wrap an inline
 * code reference or path segment in Markdown/JSDoc prose. This module lifts
 * that exact technique into a reusable, tested builder so a future
 * campaign's own invariant check (the motivating case: `alpha-rst-cli-rest-
 * transport` hand-flagged a `process.cwd()` JSDoc comment as if it were a
 * real call site, see its filed finding) reuses it instead of re-deriving —
 * or worse, re-discovering the false-positive the hard way.
 *
 * This is deliberately NOT a general comment/string parser: doing that
 * correctly requires a real tokenizer per language, which is out of
 * proportion to a diff-text manifest scan. The quoted-context heuristic is
 * cheap, matches this repo's own prose conventions (inline code always reads
 * `` `like this` ``), and is proven against the one real false positive this
 * repo has actually hit.
 */
export function excludingQuotedContext(bodyPattern: string): RegExp {
  return new RegExp(`(^|[^\`'|/])(${bodyPattern})`);
}
