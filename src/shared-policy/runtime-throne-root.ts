import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Repository root in every execution shape: source execution (`src/`),
 * plain compiled execution (`dist/`), and symlinked-generation compiled
 * execution (`dist/` -> `dist.build.<gen>/`, see
 * `scripts/build-and-publish-dist.mjs`).
 *
 * This is a structural identity check, not a directory-name convention:
 * walk upward from the running module's own (already realpath'd —
 * `import.meta.url` resolves through symlinks, see `selfInvocationUrl` in
 * `src/tools.ts`) location until a directory is found whose `package.json`
 * identifies it as the throne repository itself. A `dist.build.<gen>`
 * generation directory has no `package.json` of its own, so it is never
 * mistaken for the root regardless of its name — the walk simply continues
 * past it to the real repo root above it. This tolerates any future
 * generation-directory naming scheme, unlike matching on `"dist"` or
 * `"dist.build.*"`.
 */
export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const packageJsonPath = path.join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { name?: unknown }).name === "throne"
        ) {
          return dir;
        }
      } catch {
        // Malformed package.json can't be the throne repo root; keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `RUNTIME_THRONE_ROOT: could not locate the throne repository root ` +
          `walking up from ${startDir} (no ancestor package.json named "throne").`,
      );
    }
    dir = parent;
  }
}

export const RUNTIME_THRONE_ROOT = findRepoRoot(import.meta.dirname);

/**
 * True only when `root` is the LIVE MAIN CHECKOUT, not a linked worktree —
 * the discriminator documented as court law in `AGENTS.md`'s throne-context
 * section: a main checkout's `.git` is a real directory, while a linked
 * worktree's `.git` is a plain file (git writes `gitdir: <path>` into it).
 * A missing `.git` entry (neither shape) is conservatively NOT a main
 * checkout — callers that require a live main checkout must refuse rather
 * than guess. This is the ONE shared predicate; reuse it everywhere this
 * distinction matters instead of re-deriving it (see `install-services`'s
 * worktree-refusal guard, Regent hard requirement 2026-08-11).
 */
export function isMainCheckoutRoot(root: string): boolean {
  const gitPath = path.join(root, ".git");
  if (!existsSync(gitPath)) return false;
  return lstatSync(gitPath).isDirectory();
}
