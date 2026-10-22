import type { ProcessResult } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import { postForgejoConversationComment } from "./forgejo-feedback.ts";
import { closeForgejoPullRequest, viewForgejoPullRequest } from "./forgejo-pull-requests.ts";
import { githubSquashMergeArguments, runGithub } from "./github-pull-requests.ts";
import { FORGE } from "./host-forge.ts";
import { landPullRequestOnMain } from "./landing-on-main.ts";
import {
  decideForgeHoldingPullRequest,
  githubProgramForHost,
  parsePullRequestTarget,
  type GithubProgram,
} from "./pull-request-forge.ts";
import { printedJson, type ForgeContext } from "./pull-request-operations.ts";
import { PULL_REQUEST_STATE } from "./pull-request-shapes.ts";
import { repositoryLandsOnMain } from "./repository-lands-on-main.ts";
import { forgejoPullRequestFor, githubTwinOf, type StagedPullRequest } from "./staged-pair.ts";

export const NOTHING_MERGES_IN_FORGEJO =
  "Nothing is merged in Forgejo: it is only the staging area. Promote the pull request to GitHub with /pr-promote on the Lord's word, then merge the GitHub pull request. Nothing was merged.";

export interface MergeTarget {
  readonly url: string;
  readonly program: GithubProgram;
  readonly forgejoUrl: string | null;
}

export interface MergeTargetDecision {
  readonly mergeTarget: MergeTarget | null;
  readonly mergeTargetRefusal: string | null;
}

export interface ClosedTwin {
  readonly forgejoUrl: string;
  readonly githubUrl: string;
  readonly closed: boolean;
}

export function mergedOnGithubMessage(githubUrl: string): string {
  return `This pull request has been merged on the GitHub side: ${githubUrl}`;
}

export function githubProgramOfUrl(url: string): GithubProgram {
  return githubProgramForHost(new URL(url).hostname);
}

function notOnGithubYet(forgejoUrl: string): string {
  return `${forgejoUrl} is not on GitHub yet: it has no metadata comment linking a GitHub pull request (it was never staged or promoted), and nothing is merged in Forgejo. It must be promoted first with /pr-promote on the Lord's word.`;
}

export async function squashMergePullRequestOnGithub(context: ForgeContext, targetText: string): Promise<ProcessResult> {
  const holder = await decideForgeHoldingPullRequest(parsePullRequestTarget(targetText), context.dependencies);
  if (holder.forge === FORGE.forgejo) {
    if (await repositoryLandsOnMain(context.repo, context.dependencies)) return printedJson(await landPullRequestOnMain(context, targetText));
    throw new ForgeRefusal(NOTHING_MERGES_IN_FORGEJO);
  }
  return runGithub(
    githubSquashMergeArguments(targetText),
    { program: holder.program, repo: context.repo, bypass: context.bypass },
    context.dependencies,
  );
}

export function mergeTargetOf(githubUrl: string | null, forgejoUrl: string | null): MergeTargetDecision {
  if (githubUrl === null) return { mergeTarget: null, mergeTargetRefusal: notOnGithubYet(forgejoUrl!) };
  return { mergeTarget: { url: githubUrl, program: githubProgramOfUrl(githubUrl), forgejoUrl }, mergeTargetRefusal: null };
}

export async function isMergedOnGithub(context: ForgeContext, githubUrl: string): Promise<boolean> {
  const program = githubProgramOfUrl(githubUrl);
  const result = await runGithub(["pr", "view", githubUrl, "--json", "state"], { program, repo: context.repo, bypass: false }, context.dependencies);
  if (result.exitCode !== 0) throw new ForgeRefusal(`${program} could not read ${githubUrl} to learn whether it was merged: ${result.stderr.trim()}`);
  return (JSON.parse(result.stdout) as { state?: string }).state === PULL_REQUEST_STATE.merged;
}

export async function closeTwinMergedOnGithub(context: ForgeContext, pullRequest: StagedPullRequest): Promise<boolean> {
  const view = await viewForgejoPullRequest(context.repo, parsePullRequestTarget(pullRequest.url), pullRequest.api, context.dependencies);
  if (view.state !== PULL_REQUEST_STATE.open) return false;
  await postForgejoConversationComment(pullRequest.address, mergedOnGithubMessage(pullRequest.githubUrl), pullRequest.api);
  await closeForgejoPullRequest(pullRequest.address, pullRequest.api);
  return true;
}

export async function closeMergedTwin(context: ForgeContext, targetText: string): Promise<ClosedTwin> {
  const pullRequest = await forgejoPullRequestFor(context, targetText);
  const githubUrl = await githubTwinOf(pullRequest);
  if (githubUrl === undefined) throw new ForgeRefusal(notOnGithubYet(pullRequest.url));
  if (!(await isMergedOnGithub(context, githubUrl))) {
    throw new ForgeRefusal(`${githubUrl} is not merged on GitHub, so its Forgejo pull request ${pullRequest.url} stays open. Nothing was changed.`);
  }
  const closed = await closeTwinMergedOnGithub(context, { ...pullRequest, githubUrl });
  return { forgejoUrl: pullRequest.url, githubUrl, closed };
}
