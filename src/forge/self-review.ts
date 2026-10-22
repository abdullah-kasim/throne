import type { ForgeDependencies } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import { editForgejoPullRequest, viewForgejoPullRequest } from "./forgejo-pull-requests.ts";
import { gitOutput, isAncestor, ORIGIN_REMOTE_NAME } from "./forgejo-repository.ts";
import { parsePullRequestTarget } from "./pull-request-forge.ts";
import type { ForgeContext } from "./pull-request-operations.ts";
import { forgejoPullRequestFor } from "./staged-pair.ts";
import { selfReviewedHeadIn, withSelfReviewRecord } from "./staging-records.ts";

const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DEFAULT_BRANCH_TIP = `refs/remotes/${ORIGIN_REMOTE_NAME}/HEAD`;

export interface SelfReview {
  readonly reviewedHead: string | null;
  readonly coversHead: boolean;
}

export interface RecordedSelfReview {
  readonly url: string;
  readonly reviewedHead: string;
}

export const NO_SELF_REVIEW: SelfReview = { reviewedHead: null, coversHead: false };

export async function recordSelfReviewedHead(context: ForgeContext, targetText: string, head: string): Promise<RecordedSelfReview> {
  if (!FULL_COMMIT_SHA_PATTERN.test(head)) throw new ForgeRefusal(`--head must be a full 40-character commit sha, not "${head}". Nothing was written.`);
  const pullRequest = await forgejoPullRequestFor(context, targetText);
  const target = parsePullRequestTarget(pullRequest.url);
  const view = await viewForgejoPullRequest(context.repo, target, pullRequest.api, context.dependencies);
  const written = await editForgejoPullRequest(context.repo, target, { body: withSelfReviewRecord(view.body, head) }, pullRequest.api, context.dependencies);
  return { url: written.url, reviewedHead: head };
}

async function isCleanDefaultBranchMerge(repo: string, commit: string, parents: readonly string[], dependencies: ForgeDependencies): Promise<boolean> {
  if (parents.length !== 2) return false;
  const [first, second] = parents as [string, string];
  const mergesDefaultBranch = (await isAncestor(repo, first, DEFAULT_BRANCH_TIP, dependencies)) || (await isAncestor(repo, second, DEFAULT_BRANCH_TIP, dependencies));
  if (!mergesDefaultBranch) return false;
  const remergedTree = (await gitOutput(repo, ["merge-tree", "--write-tree", first, second], dependencies))?.split("\n")[0];
  const committedTree = await gitOutput(repo, ["rev-parse", `${commit}^{tree}`], dependencies);
  return remergedTree !== undefined && remergedTree === committedTree;
}

async function reviewedHeadCoversHead(repo: string, reviewedHead: string, head: string, dependencies: ForgeDependencies): Promise<boolean> {
  if (reviewedHead === head) return true;
  if (!(await isAncestor(repo, reviewedHead, head, dependencies))) return false;
  const commitsSince = await gitOutput(repo, ["rev-list", "--parents", `${reviewedHead}..${head}`, "--not", DEFAULT_BRANCH_TIP], dependencies);
  if (commitsSince === undefined) return false;
  for (const line of commitsSince.split("\n")) {
    const [commit, ...parents] = line.split(" ");
    if (!(await isCleanDefaultBranchMerge(repo, commit!, parents, dependencies))) return false;
  }
  return true;
}

export async function selfReviewOf(context: ForgeContext, forgejoBody: string, head: string): Promise<SelfReview> {
  const reviewedHead = selfReviewedHeadIn(forgejoBody);
  if (reviewedHead === undefined) return NO_SELF_REVIEW;
  return { reviewedHead, coversHead: await reviewedHeadCoversHead(context.repo, reviewedHead, head, context.dependencies) };
}
