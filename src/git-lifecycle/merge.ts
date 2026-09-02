// Shared git commit-creation/publish primitives: parented-commit creation,
// fast-forward/CAS branch publish, and merge-tree content resolution. Every
// convention that lands a parented commit onto a branch (single-parent
// delivery in `delivery.ts`, the two-parent `Absorb <target> into <alpha>`
// convention in `absorb-and-stamp.ts`) publishes through these, never a
// second copy of the underlying git plumbing.
import { rm } from "node:fs/promises";
import path from "node:path";
import { currentBranch, readGitStatus, runGit } from "./git-command.service.ts";
import { GitWorktreeService } from "./git-worktree.service.ts";

const WORKTREES = new GitWorktreeService();

async function restoreDirtyCheckout(checkoutDir: string): Promise<void> {
  const popped = await readGitStatus(["stash", "pop", "--index"], checkoutDir);
  if (popped.code === 0) return;

  const conflicted = (
    await runGit(["diff", "--name-only", "--diff-filter=U"], checkoutDir)
  )
    .split("\n")
    .filter(Boolean);
  for (const file of conflicted) {
    await runGit(["checkout", "--theirs", "--", file], checkoutDir);
    await runGit(["add", "--", file], checkoutDir);
    await rm(path.join(checkoutDir, `${file}.orig`), { force: true });
  }
  await runGit(["stash", "drop"], checkoutDir);
  await runGit(["reset", "--quiet"], checkoutDir);
}

/** Refuses when an ambient untracked path in `checkoutDir` collides with a
 *  path the delivered `tree` would write — publishing over it would silently
 *  absorb uncommitted local state into the delivered commit. */
export async function assertNoUntrackedCollisions(
  checkoutDir: string,
  root: string,
  tree: string,
): Promise<void> {
  const untracked = (
    await runGit(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      checkoutDir,
    )
  )
    .split("\0")
    .filter((file) => file !== "" && !file.endsWith("/"));
  if (untracked.length === 0) return;

  const delivered = (
    await runGit(["ls-tree", "-r", "--name-only", "-z", tree], root)
  )
    .split("\0")
    .filter(Boolean);
  const collision = untracked.find((ambient) =>
    delivered.some(
      (file) =>
        file === ambient ||
        file.startsWith(`${ambient}/`) ||
        ambient.startsWith(`${file}/`),
    ),
  );
  if (collision !== undefined) {
    throw new Error(
      `refusing delivery: ambient untracked path "${collision}" collides with the delivery tree; nothing was published`,
    );
  }
}

/** Fast-forward `checkoutDir`'s current branch onto `commit`, preserving any
 *  dirty working-tree state across the move (stash before, restore after).
 *  Requires `commit` to be a genuine descendant of `HEAD` — refuses
 *  otherwise, exactly what `git merge --ff-only` refuses. */
export async function fastForwardCheckout(
  checkoutDir: string,
  name: string,
  commit: string,
): Promise<void> {
  const dirty =
    (await runGit(["status", "--porcelain=v1", "-z"], checkoutDir)) !== "";
  if (dirty) {
    await runGit(
      [
        "stash",
        "push",
        "--include-untracked",
        "-m",
        `gittree-mergeback-${name}`,
      ],
      checkoutDir,
    );
  }
  try {
    const result = await readGitStatus(
      ["merge", "--ff-only", "--", commit],
      checkoutDir,
    );
    if (result.code !== 0) {
      throw new Error(
        `target moved before publication or cannot fast-forward: ${result.stderr.trim() || `git exited ${result.code}`}`,
      );
    }
  } catch (error) {
    if (dirty) await restoreDirtyCheckout(checkoutDir);
    throw error;
  }
  if (dirty) await restoreDirtyCheckout(checkoutDir);
}

export class MergeContentConflictError extends Error {}

export async function mergedTree(
  root: string,
  target: string,
  candidate: string,
): Promise<string> {
  const result = await readGitStatus(
    ["merge-tree", "--write-tree", "--messages", target, candidate],
    root,
  );
  if (result.code !== 0) {
    throw new MergeContentConflictError(
      `content conflict landing "${candidate}" — nothing was published. ` +
        `${result.stdout.trim()} ${result.stderr.trim()}`.trim(),
    );
  }
  const tree = result.stdout.split("\n", 1)[0]?.trim();
  if (!tree || !/^[0-9a-f]+$/.test(tree)) {
    throw new Error(`merge-tree returned no usable tree for "${candidate}"`);
  }
  return tree;
}

/** Create a commit for `tree` parented by `parents` (in order) with the
 *  given commit message, signed under the same `commit.gpgsign` check every
 *  parented commit in this file uses. `parents` is usually two commits (a
 *  two-way "delivered"/"absorbed" convention) but a single-parent commit is
 *  equally valid — `absorbAndStamp`'s completion stamp uses exactly one, so
 *  its tree can be content-identical to that one parent's tree and get
 *  stripped by `contentTip` like any other trailing no-op commit. Shared by
 *  `buildSquashPreview`/delivery's single-parent squash commit (`delivery.ts`)
 *  and `absorbAndStamp` (the `Absorb <target> into <alpha>` convention, and
 *  its own `Deliver <shadowName>` stamp) so every convention publishes
 *  through identical commit-tree mechanics. */
export async function createParentedCommit(
  root: string,
  tree: string,
  parents: readonly string[],
  message: string,
): Promise<string> {
  const sign =
    (
      await readGitStatus(["config", "--bool", "commit.gpgsign"], root)
    ).stdout.trim() === "true";
  const args = ["commit-tree", tree];
  for (const parent of parents) {
    args.push("-p", parent);
  }
  args.push("-m", message);
  if (sign) args.splice(1, 0, "-S");
  const result = await readGitStatus(args, root);
  if (result.code !== 0) {
    throw new Error(
      `could not create commit: ${result.stderr.trim() || `git exited ${result.code}`}`,
    );
  }
  return result.stdout.trim();
}

/** The checkout directory a publish against `targetBranch` should land
 *  through: the root itself when it already has that branch checked out,
 *  else whichever registered worktree does, else `undefined` (publish by
 *  `update-ref` instead). Shared by `delivery.ts`'s `deliver()`/
 *  `advanceCandidateBranch`/`stampNoopDelivery` so every publish and
 *  candidate-advance goes through the exact same checkout resolution. */
export async function resolveTargetCheckout(
  root: string,
  targetBranch: string,
): Promise<string | undefined> {
  return (await currentBranch(root)) === targetBranch
    ? root
    : (await WORKTREES.list(root)).find(
        (worktree) => worktree.branch === targetBranch,
      )?.path;
}

/** Create a two-parent commit for `tree` with `message` and publish it onto
 *  `branch` (fast-forwarding `checkoutDir` if one is open on it, else a CAS
 *  `update-ref` against `previousTip`). Used by `absorbAndStamp` (the
 *  `Absorb <target> into <alpha>` and, on the same branch, `Deliver
 *  <shadowName>` conventions) — delivery's own publish goes through
 *  `delivery.ts`'s single-parent `publishSquashDelivery` instead. */
export async function publishOnto(
  root: string,
  branch: string,
  previousTip: string,
  firstParent: string,
  secondParent: string,
  tree: string,
  message: string,
  checkoutDir?: string,
): Promise<string> {
  if (checkoutDir !== undefined)
    await assertNoUntrackedCollisions(checkoutDir, root, tree);
  const commit = await createParentedCommit(
    root,
    tree,
    [firstParent, secondParent],
    message,
  );
  if (checkoutDir !== undefined) {
    await fastForwardCheckout(checkoutDir, branch, commit);
  } else {
    const ref = `refs/heads/${branch}`;
    const update = await readGitStatus(
      ["update-ref", ref, commit, previousTip],
      root,
    );
    if (update.code !== 0) {
      throw new Error(
        `branch "${branch}" moved before publication; nothing was published. ${update.stderr.trim()}`,
      );
    }
  }
  return commit;
}
