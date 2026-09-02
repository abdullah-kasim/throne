// Performs the target-into-Alpha-branch absorb an absorb-gate Shadow needs
// AND stamps the acting Shadow's own branch as a single atomic call. Reuses
// `merge.ts`'s commit-creation/publish primitives (`mergedTree`,
// `createParentedCommit`/`publishOnto`, `advanceCandidateBranch`) rather
// than duplicating them — this module owns only the absorb-and-stamp
// orchestration, not a second copy of the underlying git plumbing.
import { localBranchTip } from "./branch-authority.ts";
import { readGitStatus, repoRoot, runGit } from "./git-command.service.ts";
import { THRONE_PROJECT_DIR } from "./git-worktree.service.ts";
import { advanceCandidateBranch } from "./delivery.ts";
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

/** True when `tip`'s own commit subject already IS the stamp for
 *  `shadowName` — the shape `absorbAndStamp` itself publishes. A local,
 *  single-commit check (not a repo-wide grep) so re-running the command
 *  after a successful stamp recognizes its own prior work without a second
 *  reader of `hasDeliveryCommit`'s convention. */
export async function shadowTipIsStamped(
  root: string,
  tip: string,
  shadowName: string,
): Promise<boolean> {
  const subject = (
    await readGitStatus(["log", "-1", "--format=%s", tip], root)
  ).stdout.trim();
  return subject === `Deliver ${shadowName}`;
}

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

/**
 * Perform the target-into-Alpha-branch absorb AND stamp the acting Shadow's
 * own branch as a single call — the atomic replacement for the manual
 * target synchronization and final-delivery roles currently use. Merges
 * `targetBranch`'s current tip into `alphaBranch` (three-way, same
 * `merge-tree`-based mechanics `deliver()` uses; a real content conflict
 * throws and publishes nothing), producing an `Absorb <target> into <alpha>`
 * commit. On success, in the same call, publishes a zero-diff
 * `Deliver <shadowName>` completion commit — same convention and mechanics
 * `stampNoopDelivery` uses — but published ONLY onto the Shadow's own
 * branch, never onto the Alpha branch. The Alpha branch's ref does not need
 * a second publish for anything: `reap-agent`'s own
 * `requireAdvancedSinceSpawn`/`requireReachableFromMergeTarget` preflight
 * only ever checks the SHADOW branch's own tip (against its spawn commit and
 * against its recorded merge target, the Alpha branch), so the stamp commit
 * only has to exist on the Shadow's branch to satisfy it — and
 * `hasDeliveryCommit`'s repo-wide (`--all`) scan finds it there just as well.
 * Advancing the Alpha branch's ref for this stamp used to drift its tip past
 * whatever was genuinely delivered to the campaign's actual target, which
 * could flip a correctly-delivered campaign to "not reachable" the moment
 * something asked whether the Alpha branch's real content had landed
 * upstream — the stamp commit is now a single-parent commit on `alphaTip`
 * with `alphaTip`'s own tree (a deliberately content-empty commit), created
 * directly and only fast-forwarded onto `shadowName`. `contentTip`
 * (`branch-authority.ts`) strips exactly this shape back to `alphaTip` when
 * a caller asks whether the Shadow's branch is reachable from `alphaBranch`,
 * so the unmoved Alpha branch still satisfies that check without ever
 * having to carry the stamp itself.
 *
 * The honest contract: git has no transaction spanning a merge and a later
 * commit. The absorb lands first; the stamp follows. If the stamp step
 * fails, this function throws naming the exact half-state — "absorb landed,
 * stamp missing" — after the absorb is already visible on `alphaBranch`; it
 * does not attempt to roll the absorb back, since a second mutation at the
 * exact moment the tool proved unhealthy is not a safe recovery. A second
 * invocation is idempotent: it detects an already-landed absorb (`targetBranch`
 * already an ancestor of `alphaBranch`) and an already-landed stamp
 * (the Shadow branch's own tip already carries the `Deliver <shadowName>`
 * commit) independently, and completes only whichever step is still
 * missing — so a re-run after a died-mid-stamp failure produces exactly one
 * absorb commit and one stamp commit, never a duplicate absorb.
 *
 * Repointing the Shadow's own ref is only ever done as a fast-forward:
 * before advancing it, the Shadow branch's CURRENT tip must be a git
 * ancestor of the commit being published. A gate Shadow ordinarily has no
 * commits of its own beyond its spawn point, so this is trivially true; if
 * it ever isn't (the branch carries commits the publish target doesn't
 * contain), this function refuses loudly, names the orphaned commit(s), and
 * changes nothing on that branch — repointing anyway would silently orphan
 * that work behind a reported success. A re-run that finds the Shadow's ref
 * already at the published commit is a clean no-op, not an error.
 */
export async function absorbAndStamp(
  shadowName: string,
  projectDir: string = THRONE_PROJECT_DIR,
  targetBranch: string,
  alphaBranch: string,
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

  const stampAlreadyLanded = await shadowTipIsStamped(
    root,
    shadowTip,
    shadowName,
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
        `Deliver ${shadowName}`,
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

  return {
    alphaBranch,
    shadowBranch: shadowName,
    absorbAlreadyLanded,
    stampAlreadyLanded,
    ...(absorbCommit === undefined ? {} : { absorbCommit }),
    ...(stampCommit === undefined ? {} : { stampCommit }),
  };
}
