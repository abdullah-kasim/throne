// The Lord's Case-A/Case-B squash algorithm, PREVIEW half only. Builds a
// single squashed commit — one parent, the current target tip — on a
// throwaway scratch ref, WITHOUT moving the candidate branch. Delivery (a
// separate, later campaign) is what fast-forwards target and candidate onto
// this commit; this module only produces and stamps it.
//
// Case A — target is already an ancestor of the candidate (fast-forwardable):
//   the squashed tree is simply the candidate's own tree.
// Case B — target has moved and is not an ancestor of the candidate:
//   the squashed tree is the merge of target and candidate
//   (`mergedTree`, the same plumbing `mergeBack` already uses). This is
//   content-identical to "git merge <target>; git reset --soft <target>;
//   git commit" — the transient two-parent merge commit that sequence makes
//   is never actually needed, only the tree it would produce.
// In BOTH cases the resulting commit is parented singly by the target tip,
// which is what makes it a genuine descendant of the target — a real
// fast-forward at delivery, ancestry preserved either way.
import { readGitStatus, runGit } from './git-command.service.ts';
import { localBranchTip } from './branch-authority.ts';
import { createParentedCommit, mergedTree } from './merge.ts';
import { findInternalsToken, type InternalsHit } from './squash-internals-check.ts';

export type SquashCase = 'A' | 'B';

export class InternalsMessageError extends Error {
  readonly hit: InternalsHit;
  constructor(hit: InternalsHit) {
    super(
      `commit message contains a throne-internals token: "${hit.token}" (${hit.label}). ` +
        'Refusing to invent around it — rewrite the message in plain prose with no ' +
        'agent names, role words, slice/gate references, or campaign machinery ' +
        'vocabulary, then retry.',
    );
    this.name = 'InternalsMessageError';
    this.hit = hit;
  }
}

/** The scratch ref a preview for `name` is built on. Fixed, one live preview
 *  per campaign — a re-preview overwrites it (scratch-ref lifecycle rule 1). */
export function squashPreviewRef(name: string): string {
  return `refs/throne/squash-preview/${name}`;
}

/** Case A iff `target` is already an ancestor of `candidate` — the target
 *  branch can be fast-forwarded onto the candidate with no merge. */
export async function determineSquashCase(
  root: string,
  target: string,
  candidate: string,
): Promise<SquashCase> {
  const result = await readGitStatus(
    ['merge-base', '--is-ancestor', target, candidate],
    root,
  );
  if (result.code === 0) return 'A';
  if (result.code === 1) return 'B';
  throw new Error(
    `cannot determine squash case for "${candidate}" against "${target}": ` +
      `${result.stderr.trim() || `git exited ${result.code}`}`,
  );
}

/** The tree the squash commit should carry: the candidate's own tree in
 *  Case A (nothing to merge), or the merged tree in Case B. */
async function squashTree(
  root: string,
  target: string,
  candidate: string,
  squashCase: SquashCase,
): Promise<string> {
  if (squashCase === 'A') return runGit(['rev-parse', `${candidate}^{tree}`], root);
  return mergedTree(root, target, candidate);
}

export interface SquashPreviewResult {
  readonly squashCase: SquashCase;
  /** The squashed commit — HEAD of the scratch ref, one parent (`targetSha`). */
  readonly squashCommit: string;
  readonly scratchRef: string;
  readonly candidateSha: string;
  readonly targetSha: string;
  /** The candidate tip as it stood at preview time — the recovery point, since
   *  nothing about preview moves it. Printed unconditionally on success. */
  readonly preSquashSha: string;
}

/**
 * Build (or overwrite) a squash preview for `name` against `targetBranch`,
 * on `refs/throne/squash-preview/<name>`. Never touches the candidate or
 * target branch — walking away costs nothing but the scratch ref, which the
 * next preview or a successful delivery will replace/delete.
 *
 * Throws `InternalsMessageError` on a throne-internals token in `message`,
 * and a plain `Error` when either branch is missing.
 */
export async function buildSquashPreview(
  root: string,
  name: string,
  targetBranch: string,
  message: string,
): Promise<SquashPreviewResult> {
  const hit = findInternalsToken(message);
  if (hit) throw new InternalsMessageError(hit);

  const targetSha = await localBranchTip(root, targetBranch);
  if (targetSha === undefined) {
    throw new Error(`make-squash-commit(${name}): target branch "${targetBranch}" does not exist`);
  }
  const candidateSha = await localBranchTip(root, name);
  if (candidateSha === undefined) {
    throw new Error(`make-squash-commit(${name}): candidate branch "${name}" does not exist`);
  }

  const squashCase = await determineSquashCase(root, targetSha, candidateSha);
  const tree = await squashTree(root, targetSha, candidateSha, squashCase);
  const squashCommit = await createParentedCommit(root, tree, [targetSha], message);

  const scratchRef = squashPreviewRef(name);
  // Unconditional overwrite: scratch-ref lifecycle rule 1 — one live preview
  // per campaign, always the newest, so a stale one can never be selected by
  // accident.
  const update = await readGitStatus(['update-ref', scratchRef, squashCommit], root);
  if (update.code !== 0) {
    throw new Error(
      `make-squash-commit(${name}): could not stamp scratch ref "${scratchRef}": ` +
        `${update.stderr.trim() || `git exited ${update.code}`}`,
    );
  }

  return { squashCase, squashCommit, scratchRef, candidateSha, targetSha, preSquashSha: candidateSha };
}
