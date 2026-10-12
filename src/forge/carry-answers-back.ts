import { readForgejoFeedback, type ForgejoFeedbackItem } from "./forgejo-feedback.ts";
import { GITHUB_FEEDBACK_KIND, readGithubFeedback, type GithubFeedback, type GithubFeedbackItem } from "./github-feedback.ts";
import { textSafeForGithub } from "./github-bound-text.ts";
import { replyOnGithub, resolveGithubThread } from "./github-feedback-replies.ts";
import type { ForgeContext } from "./pull-request-operations.ts";
import type { StagedPullRequest } from "./staged-pair.ts";
import { readStagingMetadataComment, writeStagingMetadataComment } from "./staging-metadata.ts";
import { withoutStagingRecords } from "./staging-records.ts";

export interface CarriedAnswers {
  readonly replied: readonly number[];
  readonly resolved: readonly string[];
}

export interface StagedFeedback {
  readonly github: GithubFeedback;
  readonly forgejoItems: readonly ForgejoFeedbackItem[];
  readonly carriedAnswers: readonly number[];
}

interface AnswerToCarry {
  readonly answer: ForgejoFeedbackItem;
  readonly githubItem: GithubFeedbackItem;
}

function carriedAnswerTexts(forgejoItems: readonly ForgejoFeedbackItem[], carriedAnswers: readonly number[]): Set<string> {
  const carried = new Set(carriedAnswers);
  return new Set(forgejoItems.filter((item) => carried.has(item.id)).map((item) => withoutStagingRecords(item.body)));
}

export async function readStagedFeedback(staged: StagedPullRequest): Promise<StagedFeedback> {
  const forgejoItems = await readForgejoFeedback(staged.address, staged.api);
  const carriedAnswers = (await readStagingMetadataComment(staged.address, staged.api))?.sync.carriedAnswers ?? [];
  const github = await readGithubFeedback(staged.githubUrl, carriedAnswerTexts(forgejoItems, carriedAnswers));
  return { github, forgejoItems, carriedAnswers };
}

function githubItemsByMirror(
  forgejoItems: readonly ForgejoFeedbackItem[],
  githubItems: readonly GithubFeedbackItem[],
): Map<number, GithubFeedbackItem> {
  const byKey = new Map(githubItems.map((item) => [item.key, item]));
  const byMirror = new Map<number, GithubFeedbackItem>();
  for (const item of forgejoItems) {
    const githubItem = item.githubKey === null ? undefined : byKey.get(item.githubKey);
    if (githubItem !== undefined) byMirror.set(item.id, githubItem);
  }
  return byMirror;
}

function answersToCarry(
  forgejoItems: readonly ForgejoFeedbackItem[],
  byMirror: Map<number, GithubFeedbackItem>,
  carried: ReadonlySet<number>,
): AnswerToCarry[] {
  return forgejoItems
    .filter((item) => item.answers !== null && byMirror.has(item.answers) && !carried.has(item.id))
    .map((answer) => ({ answer, githubItem: byMirror.get(answer.answers!)! }));
}

function threadsToResolve(forgejoItems: readonly ForgejoFeedbackItem[], byMirror: Map<number, GithubFeedbackItem>): GithubFeedbackItem[] {
  return forgejoItems
    .filter((item) => item.resolved && byMirror.has(item.id))
    .map((item) => byMirror.get(item.id)!)
    .filter((githubItem) => githubItem.kind === GITHUB_FEEDBACK_KIND.thread && !githubItem.resolved && githubItem.threadId !== null);
}

export async function carryAnswersBack(context: ForgeContext, staged: StagedPullRequest): Promise<CarriedAnswers> {
  const { github, forgejoItems, carriedAnswers } = await readStagedFeedback(staged);
  const byMirror = githubItemsByMirror(forgejoItems, github.items);
  const answers = answersToCarry(forgejoItems, byMirror, new Set(carriedAnswers));
  const replies: string[] = [];
  for (const { answer } of answers) {
    replies.push(await textSafeForGithub(answer.body, `the Forgejo answer ${answer.url}`, staged.api.rootUrl, context.dependencies));
  }
  const carried = [...carriedAnswers];
  for (const [index, { answer, githubItem }] of answers.entries()) {
    await replyOnGithub(github, githubItem, replies[index]!, context.repo, context.dependencies);
    carried.push(answer.id);
    await writeStagingMetadataComment(staged.address, staged.githubUrl, { carriedAnswers: carried }, staged.api);
  }
  const threads = threadsToResolve(forgejoItems, byMirror);
  for (const thread of threads) await resolveGithubThread(github, thread.threadId!, context.repo, context.dependencies);
  return { replied: answers.map(({ answer }) => answer.id), resolved: threads.map((thread) => thread.threadId!) };
}
