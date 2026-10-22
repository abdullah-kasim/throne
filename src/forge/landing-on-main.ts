import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ForgeDependencies } from "./forge-dependencies.ts";
import { ForgeRefusal, messageOf } from "./forge-refusal.ts";
import { postForgejoConversationComment } from "./forgejo-feedback.ts";
import type { ForgejoApi } from "./forgejo-api.ts";
import { recordForgejoPullRequestAsMerged, viewForgejoPullRequest, type ForgejoPullRequestAddress } from "./forgejo-pull-requests.ts";
import {
  BRANCH_REF_PREFIX,
  defaultBranchOf,
  fetchForgejoBranch,
  gitOutput,
  ORIGIN_REMOTE_NAME,
  originTrackingRef,
  pushToForgejo,
  runGitOrRefuse,
} from "./forgejo-repository.ts";
import { landingCommitMessage } from "./landing-commit-message.ts";
import { parsePullRequestTarget } from "./pull-request-forge.ts";
import type { ForgeContext } from "./pull-request-operations.ts";
import type { PullRequestView } from "./pull-request-shapes.ts";
import { refuseUnlessRepositoryLandsOnMain } from "./repository-lands-on-main.ts";
import { forgejoPullRequestFor } from "./staged-pair.ts";

const SCRATCH_TREE_NAME = "tree";
const COMMIT_MESSAGE_FILE_NAME = "commit-message.txt";

export interface Landing {
  readonly forgejoUrl: string;
  readonly landedCommit: string;
  readonly base: string;
  readonly closed: boolean;
}

interface Squash {
  readonly repo: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly message: string;
  readonly pullRequestUrl: string;
}

function landedOnMainMessage(commit: string): string {
  return `Landed on main as ${commit}`;
}

function refuseUnlessBasedOnDefaultBranch(view: PullRequestView, defaultBranch: string, pullRequestUrl: string): void {
  if (view.baseRefName === defaultBranch) return;
  throw new ForgeRefusal(
    `${pullRequestUrl} is based on ${view.baseRefName}, not on the default branch ${defaultBranch}, so it does not land on main; roll it into the pull request based on ${defaultBranch} first. Nothing was changed.`,
  );
}

async function fetchOriginBase(repo: string, base: string, dependencies: ForgeDependencies): Promise<string> {
  const trackingRef = originTrackingRef(base);
  await runGitOrRefuse(repo, ["fetch", "--no-tags", ORIGIN_REMOTE_NAME, `+${BRANCH_REF_PREFIX}${base}:${trackingRef}`], dependencies);
  return trackingRef;
}

async function refuseConflictingSquash(tree: string, squash: Squash, failure: string, dependencies: ForgeDependencies): Promise<never> {
  const conflicts = (await gitOutput(tree, ["diff", "--name-only", "--diff-filter=U"], dependencies)) ?? "";
  if (conflicts === "") throw new ForgeRefusal(`git merge --squash ${squash.headRef} failed on ${squash.baseRef}: ${failure}. Nothing was changed.`);
  throw new ForgeRefusal(
    `${squash.pullRequestUrl} conflicts with ${squash.baseRef} in ${conflicts.split("\n").join(", ")}, so it was not landed; bring its branch up to date with ${squash.baseRef} and push it again. Nothing was changed.`,
  );
}

async function commitSquashOnTree(tree: string, folder: string, squash: Squash, dependencies: ForgeDependencies): Promise<string> {
  const merge = await dependencies.runProcess("git", ["merge", "--squash", squash.headRef], { cwd: tree });
  if (merge.exitCode !== 0) await refuseConflictingSquash(tree, squash, merge.stderr.trim(), dependencies);
  const messageFile = path.join(folder, COMMIT_MESSAGE_FILE_NAME);
  await writeFile(messageFile, squash.message);
  await runGitOrRefuse(tree, ["commit", "-S", "-q", "-F", messageFile], dependencies);
  return (await gitOutput(tree, ["rev-parse", "HEAD"], dependencies))!;
}

async function squashCommitOnScratchWorktree(squash: Squash, dependencies: ForgeDependencies): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "forge-land-"));
  const tree = path.join(folder, SCRATCH_TREE_NAME);
  try {
    await runGitOrRefuse(squash.repo, ["worktree", "add", "--detach", "-q", tree, squash.baseRef], dependencies);
    return await commitSquashOnTree(tree, folder, squash, dependencies);
  } finally {
    await dependencies.runProcess("git", ["worktree", "remove", "--force", tree], { cwd: squash.repo });
    await rm(folder, { recursive: true, force: true });
  }
}

async function recordLandingAsMerged(address: ForgejoPullRequestAddress, commit: string, pullRequestUrl: string, api: ForgejoApi): Promise<void> {
  try {
    await recordForgejoPullRequestAsMerged(address, commit, api);
  } catch (error) {
    throw new ForgeRefusal(
      `${commit} already landed on main in GitHub and in Forgejo, and ${pullRequestUrl} was commented on, but it was not recorded as merged: ${messageOf(error)}. Nothing is pushed again.`,
    );
  }
}

export async function landPullRequestOnMain(context: ForgeContext, targetText: string): Promise<Landing> {
  const { repo, dependencies } = context;
  await refuseUnlessRepositoryLandsOnMain(repo, dependencies);
  const pullRequest = await forgejoPullRequestFor(context, targetText);
  const { api, address, url } = pullRequest;
  const view = await viewForgejoPullRequest(repo, parsePullRequestTarget(url), api, dependencies);
  const base = await defaultBranchOf(repo, dependencies);
  refuseUnlessBasedOnDefaultBranch(view, base, url);
  const baseRef = await fetchOriginBase(repo, base, dependencies);
  const headRef = await fetchForgejoBranch(repo, view.headRefName, address.repository, api, dependencies);
  const commit = await squashCommitOnScratchWorktree({ repo, baseRef, headRef, message: landingCommitMessage(view), pullRequestUrl: url }, dependencies);
  const baseBranchRef = `${BRANCH_REF_PREFIX}${base}`;
  await runGitOrRefuse(repo, ["push", ORIGIN_REMOTE_NAME, `${commit}:${baseBranchRef}`], dependencies);
  await pushToForgejo(repo, `${commit}:${baseBranchRef}`, address.repository, api, dependencies);
  await postForgejoConversationComment(address, landedOnMainMessage(commit), api);
  await recordLandingAsMerged(address, commit, url, api);
  return { forgejoUrl: url, landedCommit: commit, base, closed: true };
}
