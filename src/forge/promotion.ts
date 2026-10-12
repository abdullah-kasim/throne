import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { carryAnswersBack, type CarriedAnswers } from "./carry-answers-back.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import { gitOutput, runGitOrRefuse } from "./forgejo-repository.ts";
import { titleWithoutGithubTwinMarker } from "./forgejo-pull-request-titles.ts";
import { nameGithubTwinInForgejoTitle, viewForgejoPullRequest } from "./forgejo-pull-requests.ts";
import {
  githubCreateArguments,
  githubEditBodyArguments,
  githubPushArguments,
  runGithub,
} from "./github-pull-requests.ts";
import { closeTwinMergedOnGithub, isMergedOnGithub } from "./merging-on-github.ts";
import { downloadMediaForGithub, publishMediaOnGithub, refuseUnfinishedGithubBody } from "./promotion-media.ts";
import { textSafeForGithub } from "./github-bound-text.ts";
import { GITHUB_PROGRAM } from "./pull-request-forge.ts";
import { parsePullRequestTarget } from "./pull-request-forge.ts";
import type { ForgeContext } from "./pull-request-operations.ts";
import type { PullRequestView } from "./pull-request-shapes.ts";
import { forgejoPullRequestFor, githubTwinOf, type ForgejoPullRequest } from "./staged-pair.ts";
import { writeStagingMetadataComment } from "./staging-metadata.ts";

const GITHUB_BODY_FILE_NAME = "github-body.md";
const NOTHING_CARRIED_BACK: CarriedAnswers = { replied: [], resolved: [] };

export interface Promotion {
  readonly forgejoUrl: string;
  readonly githubUrl: string;
  readonly created: boolean;
  readonly mergedOnGithub: boolean;
  readonly answers: CarriedAnswers;
}

interface GithubText {
  readonly title: string;
  readonly bodyFile: string;
  readonly fileNames: readonly string[];
}

async function writeGithubText(
  context: ForgeContext,
  pullRequest: ForgejoPullRequest,
  view: PullRequestView,
  folder: string,
): Promise<GithubText> {
  const media = await downloadMediaForGithub(pullRequest, view.body, folder);
  const title = await textSafeForGithub(titleWithoutGithubTwinMarker(view.title), `the title of ${pullRequest.url}`, pullRequest.api.rootUrl, context.dependencies);
  const body = await textSafeForGithub(media.body, `the body of ${pullRequest.url}`, pullRequest.api.rootUrl, context.dependencies);
  const bodyFile = path.join(folder, GITHUB_BODY_FILE_NAME);
  await writeFile(bodyFile, `${body}\n`);
  return { title, bodyFile, fileNames: media.fileNames };
}

async function runGithubForTheLord(context: ForgeContext, args: readonly string[]): Promise<string> {
  const result = await runGithub(args, { program: GITHUB_PROGRAM.github, repo: context.repo, bypass: true }, context.dependencies);
  if (result.exitCode !== 0) throw new ForgeRefusal(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function lastLineOf(text: string): string {
  return text.trim().split("\n").pop()!.trim();
}

async function openOnGithub(context: ForgeContext, view: PullRequestView, githubText: GithubText): Promise<string> {
  const request = { title: githubText.title, bodyFile: githubText.bodyFile, base: view.baseRefName, head: view.headRefName, draft: view.isDraft };
  const githubUrl = lastLineOf(await runGithubForTheLord(context, githubCreateArguments(request)));
  parsePullRequestTarget(githubUrl);
  return githubUrl;
}

export async function promotePullRequest(context: ForgeContext, targetText: string): Promise<Promotion> {
  const pullRequest = await forgejoPullRequestFor(context, targetText);
  const promotedUrl = await githubTwinOf(pullRequest);
  if (promotedUrl !== undefined && (await isMergedOnGithub(context, promotedUrl))) {
    await closeTwinMergedOnGithub(context, { ...pullRequest, githubUrl: promotedUrl });
    return { forgejoUrl: pullRequest.url, githubUrl: promotedUrl, created: false, mergedOnGithub: true, answers: NOTHING_CARRIED_BACK };
  }
  const view = await viewForgejoPullRequest(context.repo, parsePullRequestTarget(pullRequest.url), pullRequest.api, context.dependencies);
  const folder = await mkdtemp(path.join(tmpdir(), "forge-promote-"));
  try {
    const githubText = await writeGithubText(context, pullRequest, view, folder);
    await runGitOrRefuse(context.repo, githubPushArguments(view.headRefName), context.dependencies);
    const promotedHead = (await gitOutput(context.repo, ["rev-parse", view.headRefName], context.dependencies)) ?? null;
    if (promotedUrl !== undefined) {
      await runGithubForTheLord(context, githubEditBodyArguments(promotedUrl, githubText.bodyFile));
    }
    const githubUrl = promotedUrl ?? (await openOnGithub(context, view, githubText));
    await writeStagingMetadataComment(pullRequest.address, githubUrl, { promotedHead }, pullRequest.api);
    await nameGithubTwinInForgejoTitle(pullRequest.address, githubUrl, pullRequest.api);
    const pair = { githubUrl, forgejoUrl: pullRequest.url, forgejoRootUrl: pullRequest.api.rootUrl };
    await publishMediaOnGithub(context, pair, folder, githubText.fileNames);
    await refuseUnfinishedGithubBody(context, pair);
    const answers = promotedUrl === undefined ? NOTHING_CARRIED_BACK : await carryAnswersBack(context, { ...pullRequest, githubUrl });
    return { forgejoUrl: pullRequest.url, githubUrl, created: promotedUrl === undefined, mergedOnGithub: false, answers };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
