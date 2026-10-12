import { parseWorktreeList, type Worktree } from "../git-lifecycle/git-worktree.service.ts";
import type { ProcessResult } from "./forge-dependencies.ts";
import { ForgeRefusal, messageOf } from "./forge-refusal.ts";
import { gitOutput } from "./forgejo-repository.ts";
import type { ForgeContext } from "./pull-request-operations.ts";
import { PULL_REQUEST_STAGE, pullRequestStatus, type PullRequestStage } from "./pull-request-status.ts";
import { recordedPullRequestOf } from "./reviewed-pull-request-record.ts";

const FINISHED_STAGES: ReadonlySet<PullRequestStage> = new Set([PULL_REQUEST_STAGE.mergedOnGithub, PULL_REQUEST_STAGE.closed]);

async function worktreesOf(repo: string, context: ForgeContext): Promise<Worktree[]> {
  const listing = await gitOutput(repo, ["worktree", "list", "--porcelain"], context.dependencies);
  if (listing === undefined) throw new ForgeRefusal(`${repo} is not a git repository.`);
  return parseWorktreeList(listing);
}

async function removeWorktree(worktree: string, stage: PullRequestStage, context: ForgeContext): Promise<string> {
  const result = await context.dependencies.runProcess("git", ["worktree", "remove", worktree], { cwd: context.repo });
  if (result.exitCode === 0) return `removed ${worktree}: its pull request is ${stage}`;
  return `kept ${worktree}: its pull request is ${stage}, but git refused to remove it: ${result.stderr.trim()}`;
}

async function cleanUpReviewWorktree(worktree: string, pullRequestUrl: string, context: ForgeContext): Promise<string> {
  let stage: PullRequestStage;
  try {
    stage = (await pullRequestStatus(context, pullRequestUrl)).stage;
  } catch (error) {
    return `kept ${worktree}: its pull request ${pullRequestUrl} could not be read: ${messageOf(error)}`;
  }
  if (!FINISHED_STAGES.has(stage)) return `kept ${worktree}: its pull request is ${stage}`;
  return removeWorktree(worktree, stage, context);
}

export async function cleanUpReviewWorktrees(context: ForgeContext): Promise<ProcessResult> {
  const lines: string[] = [];
  for (const worktree of await worktreesOf(context.repo, context)) {
    const pullRequestUrl = await recordedPullRequestOf(worktree.path, context.dependencies);
    if (pullRequestUrl !== undefined) lines.push(await cleanUpReviewWorktree(worktree.path, pullRequestUrl, context));
  }
  if (lines.length === 0) lines.push(`no review worktrees recorded by forge open in ${context.repo}`);
  return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}
