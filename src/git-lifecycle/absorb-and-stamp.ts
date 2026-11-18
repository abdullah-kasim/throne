// Performs the target-into-Alpha-branch absorb an absorb-gate Shadow needs
// AND stamps the acting Shadow's own branch as a single atomic call. Reuses
// `merge.ts`'s commit-creation/publish primitives (`mergedTree`,
// `createParentedCommit`/`publishOnto`, `advanceCandidateBranch`) rather
// than duplicating them — this module owns only the absorb-and-stamp
// orchestration, not a second copy of the underlying git plumbing.
import { localBranchTip } from "./branch-authority.ts";
import { readGitStatus, repoRoot, runGit } from "./git-command.service.ts";
import { THRONE_PROJECT_DIR } from "./git-worktree.service.ts";
import { advanceCandidateBranch, writeDeliveryEvidence } from "./delivery.ts";
import {
  createParentedCommit,
  mergedTree,
  publishOnto,
  resolveTargetCheckout,
  MergeContentConflictError,
} from "./merge.ts";

export type AbsorbTargetResult =
  | { readonly status: "nothing-to-merge"; readonly candidateCommit: string }
  | { readonly status: "merged-content"; readonly candidateCommit: string }
  | { readonly status: "conflict"; readonly reason: string };

export interface AbsorbAndStampResult {
  alphaBranch: string;
  shadowBranch: string;
  absorbAlreadyLanded: boolean;
  stampAlreadyLanded: boolean;
  absorbCommit?: string;
  stampCommit?: string;
}

async function isAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await readGitStatus(
    ["merge-base", "--is-ancestor", ancestor, descendant],
    root,
  );
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(
    `cannot determine ancestry of "${ancestor}" from "${descendant}": ${result.stderr.trim() || `git exited ${result.code}`}`,
  );
}

/** Merge the recorded target into the candidate and classify all outcomes. */
export async function absorbTargetIntoCandidate(
  candidateBranch: string,
  projectDir: string,
  targetBranch: string,
): Promise<AbsorbTargetResult> {
  const root = await repoRoot(projectDir);
  const target = await localBranchTip(root, targetBranch);
  if (target === undefined) {
    throw new Error(
      `absorbTargetIntoCandidate(${candidateBranch}): target branch ` +
        `"${targetBranch}" does not exist`,
    );
  }
  const candidate = await localBranchTip(root, candidateBranch);
  if (candidate === undefined) {
    throw new Error(
      `absorbTargetIntoCandidate(${candidateBranch}): candidate branch does not exist`,
    );
  }
  if (await isAncestor(root, target, candidate)) {
    return { status: "nothing-to-merge", candidateCommit: candidate };
  }
  try {
    const tree = await mergedTree(root, candidate, target);
    const checkout = await resolveTargetCheckout(root, candidateBranch);
    const commit = await publishOnto(
      root,
      candidateBranch,
      candidate,
      candidate,
      target,
      tree,
      `Absorb ${targetBranch} into ${candidateBranch}`,
      checkout,
    );
    return { status: "merged-content", candidateCommit: commit };
  } catch (error) {
    if (error instanceof MergeContentConflictError) {
      return { status: "conflict", reason: error.message };
    }
    throw error;
  }
}

export async function isContentEmptyCommitOn(
  root: string,
  tip: string,
  parent: string,
): Promise<boolean> {
  const parents = (
    await readGitStatus(["rev-list", "--parents", "-n", "1", tip], root)
  ).stdout.trim().split(/\s+/).slice(1);
  if (parents.length !== 1 || parents[0] !== parent) return false;
  const [tipTree, parentTree] = await Promise.all([
    runGit(["rev-parse", `${tip}^{tree}`], root),
    runGit(["rev-parse", `${parent}^{tree}`], root),
  ]);
  return tipTree === parentTree;
}

export const MERGED_INTO_TARGET_SUBJECT = "Mark this branch as merged into its target";

/** Confirm it is safe to repoint `shadowName`'s branch ref at
 *  `publishCommit` — reads the branch's CURRENT (not a stale, earlier-read)
 *  tip and requires it to be a fast-forward ancestor of `publishCommit`.
 *  Moving a branch ref to a commit that is NOT a descendant of its current
 *  tip silently orphans whatever commits only the old tip carried — they
 *  survive solely as unreferenced objects until git gc, while the caller
 *  reports success. Refuses loudly instead, naming the orphaned commits,
 *  and changes nothing (no merge, no forced ref move). Returns the current
 *  tip so callers can skip a no-op re-advance when it already equals
 *  `publishCommit`. */
export async function requireFastForwardableCandidate(
  root: string,
  shadowName: string,
  publishCommit: string,
): Promise<string> {
  const currentTip = await localBranchTip(root, shadowName);
  if (currentTip === undefined) {
    throw new Error(
      `absorbAndStamp(${shadowName}): shadow branch "${shadowName}" no longer exists`,
    );
  }
  if (
    currentTip === publishCommit ||
    (await isAncestor(root, currentTip, publishCommit))
  ) {
    return currentTip;
  }
  const divergent = (
    await readGitStatus(["rev-list", `${publishCommit}..${currentTip}`], root)
  ).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  throw new Error(
    `absorbAndStamp(${shadowName}): refusing to advance "${shadowName}" — its current tip ${currentTip} ` +
      `carries commit(s) not reachable from the stamp being published (${publishCommit}): ` +
      `${divergent.join(", ") || currentTip}. Repointing the ref would orphan that work behind a success ` +
      "message; nothing was changed on this branch.",
  );
}

export async function absorbAndStamp(
  shadowName: string,
  projectDir: string = THRONE_PROJECT_DIR,
  targetBranch: string,
  alphaBranch: string,
  dataDir?: string,
): Promise<AbsorbAndStampResult> {
  const root = await repoRoot(projectDir);
  const alphaTipBefore = await localBranchTip(root, alphaBranch);
  if (alphaTipBefore === undefined) {
    throw new Error(
      `absorbAndStamp(${shadowName}): alpha branch "${alphaBranch}" does not exist`,
    );
  }
  const shadowTip = await localBranchTip(root, shadowName);
  if (shadowTip === undefined) {
    throw new Error(
      `absorbAndStamp(${shadowName}): shadow branch "${shadowName}" does not exist`,
    );
  }

  const absorb = await absorbTargetIntoCandidate(
    alphaBranch,
    projectDir,
    targetBranch,
  );
  if (absorb.status === "conflict")
    throw new MergeContentConflictError(absorb.reason);
  const absorbAlreadyLanded = absorb.status === "nothing-to-merge";
  const alphaTip = absorb.candidateCommit;
  const absorbCommit =
    absorb.status === "merged-content" ? absorb.candidateCommit : undefined;

  const stampAlreadyLanded = await isContentEmptyCommitOn(
    root,
    shadowTip,
    alphaTip,
  );
  let stampCommit: string | undefined;
  if (!stampAlreadyLanded) {
    try {
      const alphaTree = await runGit(["rev-parse", `${alphaTip}^{tree}`], root);
      // A single-parent commit on `alphaTip`, tree identical to that one
      // parent's own tree — a deliberately content-empty commit, the exact
      // shape `contentTip` exists to see through. This is what makes the
      // stamp safe to publish WITHOUT moving `alphaBranch`: reap-agent's own
      // reachability check on the Shadow's branch runs the published tip
      // through `contentTip` first, which strips this commit straight back
      // to `alphaTip` — and `alphaTip` is (still) `alphaBranch`'s own tip,
      // trivially reachable from it. A two-parent commit here (also citing
      // `shadowTip`) would NOT work: `contentTip` never strips a merge
      // commit, and a brand-new commit can never itself be a git-ancestor of
      // an unmoved `alphaBranch` tip — that direction is only possible
      // because this commit's sole parent, `alphaTip`, already is one.
      // `shadowTip`'s own history is preserved by the fast-forward guard
      // below instead of a second parent edge: it refuses (rather than
      // orphans) if `shadowTip` is not already reachable from `alphaTip`.
      stampCommit = await createParentedCommit(
        root,
        alphaTree,
        [alphaTip],
        MERGED_INTO_TARGET_SUBJECT,
      );
      const liveShadowTip = await requireFastForwardableCandidate(
        root,
        shadowName,
        stampCommit,
      );
      if (liveShadowTip !== stampCommit) {
        await advanceCandidateBranch(
          root,
          shadowName,
          liveShadowTip,
          stampCommit,
        );
      }
    } catch (stampError) {
      const reason =
        stampError instanceof Error ? stampError.message : String(stampError);
      throw new Error(
        `absorbAndStamp(${shadowName}): absorb landed, stamp missing — "${targetBranch}" is absorbed into ` +
          `alpha branch "${alphaBranch}" at ${alphaTip}, but the completion stamp on "${shadowName}" failed: ` +
          `${reason}. Nothing further was rolled back; re-run absorbAndStamp(${shadowName}) — it will detect ` +
          "the already-landed absorb and complete only the stamp.",
      );
    }
  }

  await writeDeliveryEvidence(
    shadowName,
    root,
    alphaBranch,
    stampCommit ?? shadowTip,
    dataDir,
  );
  return {
    alphaBranch,
    shadowBranch: shadowName,
    absorbAlreadyLanded,
    stampAlreadyLanded,
    ...(absorbCommit === undefined ? {} : { absorbCommit }),
    ...(stampCommit === undefined ? {} : { stampCommit }),
  };
}
