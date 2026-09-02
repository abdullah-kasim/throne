// Single-parent delivery: `mergeBack`/`merge-git-tree`'s own delivery
// convention, wired onto `squash.ts`'s already-landed `buildSquashPreview`
// algorithm rather than reimplementing Case A/B merge logic. Reuses
// `merge.ts`'s shared commit-creation/publish primitives (`createParentedCommit`,
// `fastForwardCheckout`, `assertNoUntrackedCollisions`, `resolveTargetCheckout`)
// so every parented-commit convention in this codebase publishes through
// identical mechanics; this module owns only the delivery-specific
// orchestration — staleness/reap-before-squash checks, target-first/
// candidate-second ordering, idempotent recovery, and the required-message
// refusal.
import { localBranchTip } from './branch-authority.ts';
import { currentBranch, readGitStatus, repoRoot, runGit } from './git-command.service.ts';
import { THRONE_PROJECT_DIR } from './git-worktree.service.ts';
import {
  assertNoUntrackedCollisions,
  createParentedCommit,
  fastForwardCheckout,
  resolveTargetCheckout,
} from './merge.ts';
import { buildSquashPreview, type SquashPreviewResult } from './squash.ts';
import { SQUASH_PREVIEW_DATA, type SquashPreviewRecord } from '../agentdata/squash-preview-data.service.ts';
import { DELIVERY_EVIDENCE_DATA } from '../agentdata/delivery-evidence-data.service.ts';

export interface MergeBackResult {
  branch: string;
  commit?: string;
  noop: boolean;
  /** The delivery message resolved for this delivery attempt — either the
   *  caller's explicit `<message>` argument or the message already carried
   *  by a reused `SquashPreviewRecord`. Present on every non-throwing
   *  outcome (including a genuine no-op) so a caller stamping a no-op
   *  completion commit afterward (`stampNoopDelivery`) never has to
   *  re-resolve it. */
  message?: string;
  /** The candidate tip as it stood when its squash preview was built —
   *  after `reset --soft`-shaped squashing, the reflog is the only route
   *  back to it, so a caller prints this at delivery time. Present on every
   *  non-throwing outcome. */
  preSquashSha?: string;
}

async function restoreDirtyForceMove(checkoutDir: string): Promise<void> {
  const popped = await readGitStatus(['stash', 'pop', '--index'], checkoutDir);
  if (popped.code === 0) return;
  await runGit(['reset', '--quiet'], checkoutDir);
}

/** Force `checkoutDir`'s branch ref and working tree onto `commit`, the same
 *  dirty-stash-preserving way `fastForwardCheckout` does, but via `reset
 *  --hard` rather than `merge --ff-only`. The candidate's own advance after a
 *  squash is NOT a git ancestor relationship — a single-parent squash commit
 *  is parented by the TARGET tip, never by the candidate's own pre-squash
 *  history, so `merge --ff-only` (which requires `commit` to be a descendant
 *  of the checkout's current `HEAD`) always fails here even though the
 *  commit's tree is content-identical to the candidate's own work. Used only
 *  by `advanceCandidateBranch`'s checked-out-worktree path; the target's own
 *  publish (`publishSquashDelivery`) is a genuine fast-forward and keeps
 *  using `fastForwardCheckout`. */
async function forceMoveCheckout(
  checkoutDir: string,
  name: string,
  commit: string,
): Promise<void> {
  const dirty = (await runGit(['status', '--porcelain=v1', '-z'], checkoutDir)) !== '';
  if (dirty) {
    await runGit(
      ['stash', 'push', '--include-untracked', '-m', `gittree-mergeback-${name}`],
      checkoutDir,
    );
  }
  try {
    const result = await readGitStatus(['reset', '--hard', commit], checkoutDir);
    if (result.code !== 0) {
      throw new Error(
        `candidate branch checkout could not be moved onto its delivered squash commit: ${result.stderr.trim() || `git exited ${result.code}`}`,
      );
    }
  } catch (error) {
    if (dirty) await restoreDirtyForceMove(checkoutDir);
    throw error;
  }
  if (dirty) await restoreDirtyForceMove(checkoutDir);
}

/** Reap-before-squash precondition: refuses before any squash commit is
 *  produced or consumed for delivery when the candidate branch's own ref is
 *  missing or unreachable. The single-parent squash this replaces the
 *  two-parent merge with discards the candidate's own merge-commit ancestry,
 *  so a candidate reaped AFTER the squash has no ancestry proof left to
 *  check — this must run first, while the ref is still provably there. */
export async function assertCandidateBranchIntact(root: string, name: string): Promise<void> {
  const candidate = await localBranchTip(root, name);
  if (candidate === undefined) {
    throw new Error(
      `mergeBack(${name}): candidate branch no longer exists — refusing to squash or ` +
        'deliver without it. A candidate reaped before delivery has no ancestry proof ' +
        'left to check; recover or recreate the branch before retrying.',
    );
  }
}

/** Pinned staleness predicate (`squash-preview-data.service.ts`'s doc
 *  comment on `SquashPreviewRecord`): a preview is valid for delivery iff
 *  its stamped `candidateSha`/`targetSha` still equal the branches' current
 *  tips. Either mismatch is a drift refusal naming which SHA moved, from
 *  what to what — never a silent re-squash or a silent reuse of a stale
 *  preview. */
export function assertPreviewNotStale(
  record: Pick<SquashPreviewRecord, 'candidateSha' | 'targetSha'>,
  currentCandidateSha: string,
  currentTargetSha: string,
): void {
  if (record.candidateSha !== currentCandidateSha) {
    throw new Error(
      `mergeBack: candidate branch moved since its squash preview was built (was ` +
        `${record.candidateSha}, now ${currentCandidateSha}) — refusing the stale preview. ` +
        'Re-run make-squash-commit (or pass an explicit <message> to build a fresh one) and retry.',
    );
  }
  if (record.targetSha !== currentTargetSha) {
    throw new Error(
      `mergeBack: target branch moved since its squash preview was built (was ` +
        `${record.targetSha}, now ${currentTargetSha}) — refusing the stale preview. ` +
        'Re-run make-squash-commit (or pass an explicit <message> to build a fresh one) and retry.',
    );
  }
}

/** The single-parent commit-builder for delivery: reuses an existing,
 *  non-stale `SquashPreviewRecord` for `name` when one exists (never
 *  silently rebuilt or ignored — a stale record refuses via
 *  `assertPreviewNotStale`), else builds one fresh via `buildSquashPreview`
 *  from an explicit `message`. Refuses, mirroring
 *  `make-squash-commit-runtime.ts`'s "REQUIRED, never invented" wording,
 *  when neither an explicit message nor a valid preview record exists. No
 *  second delivery-commit builder — this is the only path. */
async function resolveDeliveryPreview(
  root: string,
  name: string,
  targetBranch: string,
  message: string | undefined,
  currentCandidateSha: string,
  currentTargetSha: string,
  dataDir?: string,
): Promise<SquashPreviewResult & { message: string }> {
  const record = await SQUASH_PREVIEW_DATA.read(name, dataDir);
  if (record !== null) {
    assertPreviewNotStale(record, currentCandidateSha, currentTargetSha);
    return {
      squashCase: record.squashCase,
      squashCommit: record.squashCommit,
      scratchRef: record.scratchRef,
      candidateSha: record.candidateSha,
      targetSha: record.targetSha,
      preSquashSha: record.preSquashSha,
      message: record.message,
    };
  }
  if (message === undefined || message.trim() === '') {
    throw new Error(
      `mergeBack(${name}): missing delivery message — the message is REQUIRED, never invented. Try:\n` +
        `  ./bin/throne-cli merge-git-tree ${name} "<what this campaign delivered>"`,
    );
  }
  const preview = await buildSquashPreview(root, name, targetBranch, message);
  return { ...preview, message };
}

/** Publish an already-built single-parent squash commit (`preview.squashCommit`,
 *  from `resolveDeliveryPreview`/`buildSquashPreview`) onto `targetBranch` —
 *  fast-forwarding `checkoutDir` if one is open on it, else a CAS
 *  `update-ref` against `previousTargetTip`. No second commit is created
 *  here; delivery only ever publishes the commit the squash algorithm
 *  already built. */
export async function publishSquashDelivery(
  root: string,
  targetBranch: string,
  previousTargetTip: string,
  preview: Pick<SquashPreviewResult, 'squashCommit'>,
  checkoutDir?: string,
): Promise<string> {
  if (checkoutDir !== undefined) {
    await assertNoUntrackedCollisions(checkoutDir, root, preview.squashCommit);
    await fastForwardCheckout(checkoutDir, targetBranch, preview.squashCommit);
  } else {
    const ref = `refs/heads/${targetBranch}`;
    const update = await readGitStatus(['update-ref', ref, preview.squashCommit, previousTargetTip], root);
    if (update.code !== 0) {
      throw new Error(
        `branch "${targetBranch}" moved before publication; nothing was published. ${update.stderr.trim()}`,
      );
    }
  }
  return preview.squashCommit;
}

/** Write the delivery-landing evidence ledger record for a genuinely new
 *  delivery — the primary signal `complete-agent`/`reap-agent`/
 *  `delivery-commit-proof.ts` read (grep of `Deliver <name>` commit messages
 *  retained there only as a fallback for pre-migration agents). Called
 *  immediately after the target-branch publish succeeds; independent of the
 *  candidate-branch advance that follows. */
async function writeDeliveryEvidence(
  name: string,
  repo: string,
  targetBranch: string,
  commit: string,
  dataDir?: string,
): Promise<void> {
  await DELIVERY_EVIDENCE_DATA.write(name, { repo, targetBranch, commit }, dataDir);
}

/** Reused outside this module by the reapability-claim auto-proof leg — a
 *  second ancestor-check implementation must not exist alongside this one. */
export async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await readGitStatus(['merge-base', '--is-ancestor', ancestor, descendant], root);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(
    `cannot determine ancestry of "${ancestor}" from "${descendant}": ${result.stderr.trim() || `git exited ${result.code}`}`,
  );
}

async function isCandidateBehindRecordedDelivery(
  root: string,
  candidate: string,
  recordedDelivery: string,
): Promise<boolean> {
  if (await isAncestor(root, candidate, recordedDelivery)) return true;
  if (await isAncestor(root, recordedDelivery, candidate)) return false;

  // A target-first crash leaves sibling commits because the single-parent
  // squash is parented by the target, not the candidate. Their identical
  // trees distinguish that exact unpublished candidate from divergent work.
  const candidateTree = await runGit(['rev-parse', `${candidate}^{tree}`], root);
  const recordedTree = await runGit(['rev-parse', `${recordedDelivery}^{tree}`], root);
  return candidateTree === recordedTree;
}

export async function mergeBranchInto(
  checkoutDir: string,
  name: string,
  message?: string,
  dataDir?: string,
): Promise<MergeBackResult> {
  const root = await repoRoot(checkoutDir);
  const branch = await currentBranch(checkoutDir);
  if (!branch) throw new Error(`mergeBack(${name}): target checkout is detached`);
  return deliver(root, name, branch, message, checkoutDir, dataDir);
}

async function deliver(
  root: string,
  name: string,
  targetBranch: string,
  message: string | undefined,
  checkoutDir?: string,
  dataDir?: string,
): Promise<MergeBackResult> {
  await assertCandidateBranchIntact(root, name);

  const candidate = await localBranchTip(root, name);
  if (candidate === undefined) throw new Error(`mergeBack(${name}): candidate branch no longer exists`);
  const target = await localBranchTip(root, targetBranch);
  if (target === undefined) {
    throw new Error(`mergeBack(${name}): recorded merge target branch "${targetBranch}" no longer exists`);
  }

  // Idempotent recovery, checked BEFORE resolving/building any preview: a
  // prior run already fast-forwarded the target onto its delivered squash
  // commit but crashed (or was killed) before advancing the candidate
  // branch. Keyed off the delivery-evidence ledger, not a freshly rebuilt
  // preview's commit hash — `commit-tree` bakes in a committer timestamp, so
  // rebuilding "the same" squash on a later run never reproduces the exact
  // SHA a prior run already published, and comparing against a rebuilt
  // commit would silently misclassify recovery as a legitimate no-op
  // instead of finishing the candidate move. Never refuse and never
  // re-squash — finish only the candidate move.
  const priorDelivery = await DELIVERY_EVIDENCE_DATA.read(name, dataDir);
  if (
    priorDelivery !== null &&
    priorDelivery.commit === target &&
    (await isCandidateBehindRecordedDelivery(root, candidate, priorDelivery.commit))
  ) {
    if (candidate !== priorDelivery.commit) {
      await advanceCandidateBranch(root, name, candidate, priorDelivery.commit);
    }
    return { branch: targetBranch, commit: priorDelivery.commit, noop: false };
  }

  const preview = await resolveDeliveryPreview(root, name, targetBranch, message, candidate, target, dataDir);

  const squashTree = await runGit(['rev-parse', `${preview.squashCommit}^{tree}`], root);
  const targetTree = await runGit(['rev-parse', `${target}^{tree}`], root);
  if (squashTree === targetTree) return { branch: targetBranch, noop: true, message: preview.message, preSquashSha: preview.preSquashSha };

  // Target-first, candidate-second: a crash between these two lines leaves
  // the target already carrying the delivered commit and the candidate not
  // yet advanced — the exact recoverable state the idempotent-recovery
  // branch above completes on the next run.
  const commit = await publishSquashDelivery(root, targetBranch, target, preview, checkoutDir);
  await writeDeliveryEvidence(name, root, targetBranch, commit, dataDir);
  await advanceCandidateBranch(root, name, candidate, commit);
  return { branch: targetBranch, commit, noop: false, message: preview.message, preSquashSha: preview.preSquashSha };
}

export async function mergeBack(
  name: string,
  projectDir: string = THRONE_PROJECT_DIR,
  targetBranch: string,
  message?: string,
  dataDir?: string,
): Promise<MergeBackResult> {
  const root = await repoRoot(projectDir);
  const checkout = await resolveTargetCheckout(root, targetBranch);
  return deliver(root, name, targetBranch, message, checkout, dataDir);
}

/** Advance the candidate's own local branch ref to the published stamp
 *  commit (CAS against its pre-stamp tip). A no-op candidate's tip never
 *  otherwise moves past its recorded spawn commit, so `reap-agent`'s own
 *  preflight (`branch-cleanup.ts` → `requireAdvancedSinceSpawn` +
 *  `requireReachableFromMergeTarget`) independently refuses teardown even
 *  after `hasDeliveryCommit` finds the stamp on the target branch — the
 *  candidate branch must carry the same commit too. Resolves whether `name`
 *  (the branch being advanced, not any other branch a caller may have
 *  resolved a checkout for) is itself checked out somewhere and, if so,
 *  moves that checkout through `forceMoveCheckout` — NOT a fast-forward: a
 *  single-parent squash commit is parented by the TARGET tip, never by the
 *  candidate's own pre-squash history, so the candidate is never a git
 *  ancestor of it even though the tree is content-identical — so a Shadow
 *  with the candidate branch open never sees its worktree left pointing at
 *  the pre-stamp tip while `HEAD`'s ref has already moved. Falls back to the
 *  bare CAS `update-ref` when the branch isn't checked out anywhere. Also
 *  used, unmodified, by `absorbAndStamp`'s own two-parent `Absorb <target>
 *  into <alpha>` convention. */
export async function advanceCandidateBranch(
  root: string,
  name: string,
  previousTip: string,
  commit: string,
): Promise<void> {
  // `resolveTargetCheckout` resolves `root` itself whenever `root`'s OWN
  // current branch happens to equal `name` — which, for `name`'s own
  // candidate branch, means the shared/live checkout at `root` (not a
  // worktree dedicated to this candidate) has been checked out onto it,
  // e.g. a `99a`/`99e` gate rehearsing an absorb in place. `root` is not
  // this candidate's own worktree — other campaigns' uncommitted work can
  // legitimately be sitting there, and this tool must never touch state it
  // does not own (`absorb-git-tree`'s never-touch-ambient-dirt invariant:
  // a stash/reset/restore round-trip through `forceMoveCheckout` is exactly
  // the kind of mutation that can lose or corrupt someone else's dirt on a
  // failed restore). A REGISTERED WORKTREE matching `name`, by contrast, is
  // this candidate's own dedicated worktree under
  // `~/.throne/worktrees/<repo>/<name>` — genuinely owned by it, safe to
  // force-move. So this only ever force-moves a checkout distinct from
  // `root`; when the resolved checkout IS `root`, it falls through to the
  // ref-only `update-ref` path below exactly as if no checkout were open at
  // all, leaving `root`'s working tree untouched.
  const resolvedCheckout = await resolveTargetCheckout(root, name);
  const checkout =
    resolvedCheckout !== undefined && resolvedCheckout !== root
      ? resolvedCheckout
      : undefined;
  if (checkout !== undefined) {
    try {
      await forceMoveCheckout(checkout, name, commit);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `stampNoopDelivery(${name}): candidate branch moved before its stamp ` +
          `could be recorded; target already published, candidate was not. ${reason}`,
      );
    }
    return;
  }
  const update = await readGitStatus(
    ['update-ref', `refs/heads/${name}`, commit, previousTip],
    root,
  );
  if (update.code !== 0) {
    throw new Error(
      `stampNoopDelivery(${name}): candidate branch moved before its stamp ` +
        `could be recorded; target already published, candidate was not. ${update.stderr.trim()}`,
    );
  }
}

/**
 * Stamp and publish a single-parent completion commit for a legitimate
 * no-op merge — a candidate whose tree already equals its target's tree, so
 * there is no content diff for `deliver()` to land. The commit's tree equals
 * the (unchanged) target tree, parented singly by `target` (the same
 * single-parent convention `deliver()`'s real-delivery path publishes),
 * signed via the shared `createParentedCommit`/`fastForwardCheckout`/
 * `assertNoUntrackedCollisions` internals. This is tool-generated evidence —
 * it only runs after a real `mergeBack` call has already proven the tree is
 * a true no-op — never a Shadow's self-assertion. Callers must confirm the
 * noop classification first (`mergeBack` returning `{ noop: true }`, and the
 * caller-owned distinction between a legitimate no-op and a WLS defect);
 * this function does not re-derive that judgment. `message` is required —
 * ordinarily the same message `mergeBack` already resolved and returned on
 * its `{ noop: true }` result, so a caller never has to re-resolve it.
 *
 * Publishes the SAME commit on both `refs/heads/<targetBranch>` (via
 * `publishSquashDelivery`'s single-parent CAS/fast-forward mechanics) AND
 * `refs/heads/<name>` itself, so both `hasDeliveryCommit` (reads the target
 * branch's reachable history) and `reap-agent`'s branch-cleanup preflight
 * (reads the candidate branch's own tip against its recorded spawn commit
 * and merge-target reachability) find proof. Also writes the delivery-
 * evidence ledger record. Returns the published commit hash.
 */
export async function stampNoopDelivery(
  name: string,
  projectDir: string = THRONE_PROJECT_DIR,
  targetBranch: string,
  message: string,
  dataDir?: string,
): Promise<string> {
  const root = await repoRoot(projectDir);
  const target = await localBranchTip(root, targetBranch);
  const candidate = await localBranchTip(root, name);
  if (target === undefined) {
    throw new Error(`stampNoopDelivery(${name}): recorded merge target branch "${targetBranch}" no longer exists`);
  }
  if (candidate === undefined) {
    throw new Error(`stampNoopDelivery(${name}): candidate branch no longer exists`);
  }
  const tree = await runGit(['rev-parse', `${target}^{tree}`], root);
  const checkout = await resolveTargetCheckout(root, targetBranch);
  const commit = await createParentedCommit(root, tree, [target], message);
  const published = await publishSquashDelivery(root, targetBranch, target, { squashCommit: commit }, checkout);
  await writeDeliveryEvidence(name, root, targetBranch, published, dataDir);
  await advanceCandidateBranch(root, name, candidate, published);
  return published;
}
