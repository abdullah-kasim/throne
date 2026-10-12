import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mirrorFeedbackToTwin } from "./feedback-mirror.ts";
import { ForgeRefusal, messageOf } from "./forge-refusal.ts";
import type { ForgejoApi } from "./forgejo-api.ts";
import { createForgejoPullRequest, forgejoPullRequestAddressOf, nameGithubTwinInForgejoTitle } from "./forgejo-pull-requests.ts";
import { githubViewArguments, runGithub } from "./github-pull-requests.ts";
import { FORGE } from "./host-forge.ts";
import {
  decideForgeHoldingPullRequest,
  forgejoTwinUrlOfGithubPullRequest,
  parsePullRequestTarget,
  type GithubProgram,
  type PullRequestUrlTarget,
} from "./pull-request-forge.ts";
import { openForgejoApiOnThisHost, type ForgeContext } from "./pull-request-operations.ts";
import type { PullRequestView } from "./pull-request-shapes.ts";
import { downloadMediaForForgejo, publishMediaOnForgejo } from "./staging-media.ts";
import { writeStagingMetadataComment } from "./staging-metadata.ts";
import { withoutStagingRecords, type StagingSync } from "./staging-records.ts";

const REVIEW_HOOK_BASE_VARIABLE = "AI_REVIEW_HOOK_BASE";

export interface Staging {
  readonly githubUrl: string;
  readonly twinUrl: string;
  readonly created: boolean;
}

interface GithubPullRequestToStage {
  readonly target: PullRequestUrlTarget;
  readonly program: GithubProgram;
  readonly url: string;
}

async function githubPullRequestToStage(context: ForgeContext, targetText: string): Promise<GithubPullRequestToStage> {
  const target = parsePullRequestTarget(targetText);
  const holder = target.kind === "url" ? await decideForgeHoldingPullRequest(target, context.dependencies) : undefined;
  if (target.kind !== "url" || holder?.forge !== FORGE.github) {
    throw new ForgeRefusal(`forge stage takes the URL of a GitHub pull request, and ${targetText} is not one.`);
  }
  const url = `${target.origin}/${target.owner}/${target.repository}/pull/${target.number}`;
  return { target, program: holder.program, url };
}

async function viewGithubPullRequest(context: ForgeContext, pullRequest: GithubPullRequestToStage): Promise<PullRequestView> {
  const invocation = { program: pullRequest.program, repo: context.repo, bypass: false };
  const result = await runGithub(githubViewArguments(pullRequest.url), invocation, context.dependencies);
  if (result.exitCode !== 0) throw new ForgeRefusal(`reading ${pullRequest.url} from GitHub failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout) as PullRequestView;
}

async function refuseHeadBranchNotFetched(context: ForgeContext, head: string): Promise<void> {
  const local = await context.dependencies.runProcess("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${head}`], { cwd: context.repo });
  if (local.exitCode === 0) return;
  throw new ForgeRefusal(
    `the head branch ${head} is not fetched in ${context.repo}; run \`git fetch origin ${head}:${head}\` there, then stage again. Nothing was changed.`,
  );
}

function reviewHookBaseRefusal(pullRequest: GithubPullRequestToStage, base: string, message: string): ForgeRefusal {
  return new ForgeRefusal(
    `the push to Forgejo was refused by the review hook, which found no base to review against; run \`git fetch origin +refs/heads/${base}:refs/remotes/origin/${base}\`, then stage again as \`${REVIEW_HOOK_BASE_VARIABLE}=origin/${base} throne forge stage ${pullRequest.url}\`: ${message}`,
  );
}

async function openForgejoTwin(
  context: ForgeContext,
  pullRequest: GithubPullRequestToStage,
  view: PullRequestView,
  body: string,
  api: ForgejoApi,
): Promise<PullRequestView> {
  const request = { title: view.title, body, base: view.baseRefName, head: view.headRefName, draft: view.isDraft, githubUrl: pullRequest.url };
  try {
    return await createForgejoPullRequest(context.repo, request, api, context.dependencies);
  } catch (error) {
    if (messageOf(error).includes(REVIEW_HOOK_BASE_VARIABLE)) throw reviewHookBaseRefusal(pullRequest, view.baseRefName, messageOf(error));
    throw error;
  }
}

async function recordGithubTwinOn(
  context: ForgeContext,
  twinUrl: string,
  githubUrl: string,
  syncChanges: Partial<StagingSync>,
  api: ForgejoApi,
): Promise<void> {
  const address = await forgejoPullRequestAddressOf(context.repo, parsePullRequestTarget(twinUrl), api, context.dependencies);
  await writeStagingMetadataComment(address, githubUrl, syncChanges, api);
  await nameGithubTwinInForgejoTitle(address, githubUrl, api);
}

async function openStagedTwin(context: ForgeContext, pullRequest: GithubPullRequestToStage, api: ForgejoApi): Promise<string> {
  const view = await viewGithubPullRequest(context, pullRequest);
  await refuseHeadBranchNotFetched(context, view.headRefName);
  const folder = await mkdtemp(path.join(tmpdir(), "forge-stage-"));
  try {
    const media = await downloadMediaForForgejo(context, pullRequest.program, withoutStagingRecords(view.body), folder);
    const twin = await openForgejoTwin(context, pullRequest, view, media.body, api);
    await publishMediaOnForgejo(context, twin.url, folder, media.fileNames);
    await recordGithubTwinOn(context, twin.url, pullRequest.url, { promotedHead: null }, api);
    return twin.url;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

export async function stageGithubPullRequest(context: ForgeContext, targetText: string): Promise<Staging> {
  const pullRequest = await githubPullRequestToStage(context, targetText);
  const api = await openForgejoApiOnThisHost(context.dependencies);
  const stagedTwinUrl = await forgejoTwinUrlOfGithubPullRequest(pullRequest.target, api);
  if (stagedTwinUrl !== undefined) {
    await recordGithubTwinOn(context, stagedTwinUrl, pullRequest.url, {}, api);
    return { githubUrl: pullRequest.url, twinUrl: stagedTwinUrl, created: false };
  }
  const twinUrl = await openStagedTwin(context, pullRequest, api);
  await mirrorFeedbackToTwin(context, pullRequest.url);
  return { githubUrl: pullRequest.url, twinUrl, created: true };
}
