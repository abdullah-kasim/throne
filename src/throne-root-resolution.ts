// Live-throne-root discovery: resolving which on-disk checkout is the LIVE
// throne root regardless of which worktree is currently executing this code.
// Split out on its own — root resolution is a distinct concern from
// steering-specific validation, and both `steering-user-config.ts` and
// `user-config-loader.ts` need it (the merged `config.user.ts` file lives at
// the live root; steering resolves the root to find that file, and the
// loader resolves it as its own default when no explicit path is given).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { runGit } from './git-lifecycle/git-command.service.ts';
import { isPlainObject } from './shared-policy/config-value-shape.ts';
import {
  isMainCheckoutRoot,
  RUNTIME_THRONE_ROOT,
} from './shared-policy/runtime-throne-root.ts';

/** True only when `root` is the throne's own checkout, not merely "a git repo
 *  the cwd happens to sit inside": a cross-repo campaign routinely runs this
 *  module from a worktree of some OTHER git repository (the target repo, not
 *  the throne), and `git rev-parse --git-common-dir` resolves happily against
 *  that foreign repo's own `.git` — silently returning the wrong "live throne
 *  root" with no diagnostic. Checked cheaply, fs-only, no extra process
 *  spawn: the throne's own repo shape is `src/tools.ts` present and a
 *  `package.json` whose `name` field is `"throne"`. */
export function isThroneCheckout(root: string): boolean {
  if (!existsSync(path.join(root, 'src', 'tools.ts'))) return false;
  const packageJsonPath = path.join(root, 'package.json');
  if (!existsSync(packageJsonPath)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return false;
  }
  return isPlainObject(parsed) && parsed.name === 'throne';
}

/** Resolves the LIVE throne root regardless of which worktree checkout is
 *  currently running this code.
 *
 *  When `cwd` is NOT explicitly passed, resolution is anchored to the
 *  RUNNING MODULE'S OWN on-disk location (`RUNTIME_THRONE_ROOT`) — the
 *  compiled dist file actually executing always lives inside the real live
 *  throne checkout, regardless of which repo the calling process's cwd sits
 *  in. This is the production path: every production call site invokes this
 *  function with zero arguments, so a cross-repo campaign agent running from
 *  a target-repo worktree still resolves the correct root with no git call
 *  at all.
 *
 *  When `cwd` IS explicitly passed — the test/fixture contract, or any
 *  future caller that has its own reason to name an explicit root — the
 *  root is instead derived via `git rev-parse --git-common-dir`, which
 *  resolves to the main repository's `.git` directory even from inside any
 *  of its worktrees, so a worktree-executed load and a live-root-executed
 *  load target the identical override file. The root is the DIRECTORY
 *  CONTAINING that `.git`, full stop — this used to append a `throne`
 *  segment, from the era when the throne was a subdirectory of the dotfiles
 *  monorepo; once the throne became its own repository that produced
 *  `<repo>/throne`, a path that does not exist, so every user override
 *  resolved to a missing file and silently fell back to the committed
 *  defaults with no diagnostic anywhere. That resolved root is also
 *  verified to actually BE the throne checkout (see `isThroneCheckout`), as
 *  defense-in-depth: an explicit cwd that resolves via git to a foreign repo
 *  (the cross-repo-campaign shape — a worktree of some OTHER repository)
 *  throws loudly instead of silently returning that foreign path. */
export async function resolveLiveThroneRoot(
  cwd?: string,
): Promise<string> {
  // `THRONE_LIVE_ROOT`, when set to a non-empty value, names the live root
  // outright and short-circuits discovery entirely — no `rev-parse` call,
  // no `RUNTIME_THRONE_ROOT` walk. An explicit override any caller may use:
  // the test harness sets it for hermeticity (see `package.json`'s `test`
  // script), not exclusively a test seam.
  const overrideRoot = process.env.THRONE_LIVE_ROOT;
  if (overrideRoot !== undefined && overrideRoot !== '') {
    return path.resolve(overrideRoot);
  }
  if (cwd === undefined) {
    if (!isMainCheckoutRoot(RUNTIME_THRONE_ROOT)) {
      throw new Error(
        `Refusing to resolve the live throne root: this checkout ` +
          `("${RUNTIME_THRONE_ROOT}") is not the live main checkout — its ` +
          `".git" is a linked-worktree file, not a real directory — and no ` +
          `THRONE_LIVE_ROOT override is set. Set THRONE_LIVE_ROOT to the ` +
          `live main checkout's path, or invoke from the main checkout ` +
          `itself.`,
      );
    }
    return RUNTIME_THRONE_ROOT;
  }
  let gitCommonDir: string;
  try {
    gitCommonDir = await runGit(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      cwd,
    );
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : inspect(cause);
    throw new Error(
      `Could not resolve the live throne root from "${cwd}": ${detail}`,
      { cause },
    );
  }
  const liveRoot = path.dirname(gitCommonDir);
  if (!isThroneCheckout(liveRoot)) {
    throw new Error(
      `Could not resolve the live throne root from "${cwd}": git resolved ` +
        `"${gitCommonDir}" (root "${liveRoot}"), which is not a throne ` +
        `checkout (missing "src/tools.ts" or a package.json named "throne"). ` +
        `This cwd is inside a different git repository, not the throne — set ` +
        `THRONE_LIVE_ROOT explicitly when running from outside a throne ` +
        `checkout (e.g. a cross-repo campaign worktree).`,
    );
  }
  return liveRoot;
}
