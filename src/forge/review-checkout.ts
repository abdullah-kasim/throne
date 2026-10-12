import path from "node:path";
import { parseWorktreeList, realIdentity, type Worktree } from "../git-lifecycle/git-worktree.service.ts";
import type { ForgeDependencies } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import { FORGEJO_REMOTE_NAME, gitOutput, ORIGIN_REMOTE_NAME, runGitOrRefuse } from "./forgejo-repository.ts";
import { FORGE } from "./host-forge.ts";
import { TARGET_KIND, type TargetKind } from "./pull-request-status.ts";

export const REVIEW_CHECKOUT_HOW = { reused: "reused", moved: "moved", created: "created" } as const;
export type ReviewCheckoutHow = (typeof REVIEW_CHECKOUT_HOW)[keyof typeof REVIEW_CHECKOUT_HOW];

export const DIRTY_REASON = "dirty";
export const DIFFERENT_HEAD_REASON = "different head";

export interface ReviewCheckoutHead {
  readonly number: number;
  readonly headBranch: string;
  readonly headSha: string;
  readonly holder: (typeof FORGE)[keyof typeof FORGE];
  readonly targetKind: TargetKind;
}

export interface ReviewCheckoutRequest {
  readonly checkout: string;
  readonly head: ReviewCheckoutHead;
  readonly liveAgentNames: ReadonlySet<string>;
  readonly fetchEnvironment?: NodeJS.ProcessEnv;
}

export interface SkippedWorktree {
  readonly path: string;
  readonly reason: string;
}

export interface ReviewCheckout {
  readonly path: string;
  readonly how: ReviewCheckoutHow;
  readonly isReviewWorktree: boolean;
  readonly skipped: readonly SkippedWorktree[];
}

export function liveAgentReason(name: string): string {
  return `live agent ${name}`;
}

function branchSlugOf(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function reviewWorktreePath(checkout: string, head: ReviewCheckoutHead): string {
  const suffix = head.targetKind === TARGET_KIND.branch ? branchSlugOf(head.headBranch) : `pr-${head.number}`;
  return path.join(path.dirname(checkout), `${path.basename(checkout)}-${suffix}`);
}

function holderRemoteOf(head: ReviewCheckoutHead): string {
  return head.holder === FORGE.forgejo ? FORGEJO_REMOTE_NAME : ORIGIN_REMOTE_NAME;
}

function headRefsOf(head: ReviewCheckoutHead): string[] {
  return [`refs/heads/${head.headBranch}`, `refs/pull/${head.number}/head`];
}

function isSamePath(left: string, right: string): boolean {
  return realIdentity(left) === realIdentity(right);
}

async function worktreesOf(checkout: string, dependencies: ForgeDependencies): Promise<Worktree[]> {
  const listing = await gitOutput(checkout, ["worktree", "list", "--porcelain"], dependencies);
  if (listing === undefined) throw new ForgeRefusal(`${checkout} is not a git repository.`);
  return parseWorktreeList(listing);
}

async function isClean(worktree: string, dependencies: ForgeDependencies): Promise<boolean> {
  return (await gitOutput(worktree, ["status", "--porcelain"], dependencies)) === "";
}

async function reasonNotToReuse(
  worktree: Worktree,
  request: ReviewCheckoutRequest,
  dependencies: ForgeDependencies,
): Promise<string | undefined> {
  const name = path.basename(worktree.path);
  if (request.liveAgentNames.has(name)) return liveAgentReason(name);
  if (worktree.head !== request.head.headSha) return DIFFERENT_HEAD_REASON;
  if (!(await isClean(worktree.path, dependencies))) return DIRTY_REASON;
  return undefined;
}

async function hasCommit(checkout: string, sha: string, dependencies: ForgeDependencies): Promise<boolean> {
  const result = await dependencies.runProcess("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: checkout });
  return result.exitCode === 0;
}

async function fetchPullRequestHead(request: ReviewCheckoutRequest, dependencies: ForgeDependencies): Promise<void> {
  const { checkout, head, fetchEnvironment } = request;
  if (await hasCommit(checkout, head.headSha, dependencies)) return;
  const remote = holderRemoteOf(head);
  if (await gitOutput(checkout, ["remote", "get-url", remote], dependencies) === undefined) {
    throw new ForgeRefusal(`${checkout} has no remote named ${remote} to fetch the pull request head from; add it, then open the pull request again.`);
  }
  for (const ref of headRefsOf(head)) {
    await dependencies.runProcess("git", ["fetch", "--no-tags", remote, ref], { cwd: checkout, environment: fetchEnvironment });
    if (await hasCommit(checkout, head.headSha, dependencies)) return;
  }
  throw new ForgeRefusal(`${remote} in ${checkout} did not provide the pull request head ${head.headSha} under ${headRefsOf(head).join(" or ")}.`);
}

async function moveReviewWorktree(
  reviewWorktree: Worktree,
  request: ReviewCheckoutRequest,
  dependencies: ForgeDependencies,
): Promise<void> {
  if (!(await isClean(reviewWorktree.path, dependencies))) {
    throw new ForgeRefusal(`${reviewWorktree.path} has uncommitted changes; it was left untouched. Commit or discard them, then open the pull request again.`);
  }
  if (reviewWorktree.detached !== true) {
    throw new ForgeRefusal(`${reviewWorktree.path} has a branch checked out; it was left untouched. Detach it, then open the pull request again.`);
  }
  await fetchPullRequestHead(request, dependencies);
  await runGitOrRefuse(reviewWorktree.path, ["checkout", "--quiet", "--detach", request.head.headSha], dependencies);
}

async function createReviewWorktree(reviewPath: string, request: ReviewCheckoutRequest, dependencies: ForgeDependencies): Promise<void> {
  await fetchPullRequestHead(request, dependencies);
  await runGitOrRefuse(request.checkout, ["worktree", "add", "--detach", reviewPath, request.head.headSha], dependencies);
}

export async function chooseReviewCheckout(request: ReviewCheckoutRequest, dependencies: ForgeDependencies): Promise<ReviewCheckout> {
  const worktrees = await worktreesOf(request.checkout, dependencies);
  const reviewPath = reviewWorktreePath(request.checkout, request.head);
  const skipped: SkippedWorktree[] = [];
  for (const worktree of worktrees) {
    const reason = await reasonNotToReuse(worktree, request, dependencies);
    if (reason === undefined) {
      return { path: worktree.path, how: REVIEW_CHECKOUT_HOW.reused, isReviewWorktree: isSamePath(worktree.path, reviewPath), skipped };
    }
    skipped.push({ path: worktree.path, reason });
  }
  const reviewWorktree = worktrees.find((worktree) => isSamePath(worktree.path, reviewPath));
  const otherSkipped = skipped.filter((entry) => !isSamePath(entry.path, reviewPath));
  if (reviewWorktree !== undefined) {
    await moveReviewWorktree(reviewWorktree, request, dependencies);
    return { path: reviewWorktree.path, how: REVIEW_CHECKOUT_HOW.moved, isReviewWorktree: true, skipped: otherSkipped };
  }
  await createReviewWorktree(reviewPath, request, dependencies);
  return { path: reviewPath, how: REVIEW_CHECKOUT_HOW.created, isReviewWorktree: true, skipped: otherSkipped };
}
