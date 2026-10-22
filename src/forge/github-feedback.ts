import path from "node:path";
import { pathToFileURL } from "node:url";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import { ForgeRefusal, messageOf } from "./forge-refusal.ts";
import { githubProgramForHost, parsePullRequestTarget, type GithubProgram } from "./pull-request-forge.ts";
import { withoutStagingRecords } from "./staging-records.ts";

const THREADS_SCRIPT_PATH = path.join(RUNTIME_THRONE_ROOT, ".claude", "skills", "pr-address-feedback", "threads.mjs");
const AUTOMATED_AUTHOR_SUFFIX = "[bot]";

export const GITHUB_FEEDBACK_KIND = { thread: "thread", comment: "comment", review: "review" } as const;
export type GithubFeedbackKind = (typeof GITHUB_FEEDBACK_KIND)[keyof typeof GITHUB_FEEDBACK_KIND];

export interface GithubFeedbackComment {
  readonly author: string;
  readonly body: string;
}

export interface GithubFeedbackItem {
  readonly key: string;
  readonly kind: GithubFeedbackKind;
  readonly pullRequestNumber: number;
  readonly id: number;
  readonly threadId: string | null;
  readonly resolved: boolean;
  readonly path: string | null;
  readonly line: number | null;
  readonly url: string;
  readonly comments: readonly GithubFeedbackComment[];
}

export interface GithubRepository {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

export interface GithubFeedback extends GithubRepository {
  readonly items: readonly GithubFeedbackItem[];
}

interface DumpedComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
}

interface DumpedThread {
  readonly id: string;
  readonly resolved: boolean;
  readonly path: string | null;
  readonly line: number | null;
  readonly originalLine: number | null;
  readonly comments: readonly DumpedComment[];
}

interface DumpedConversationEntry extends DumpedComment {
  readonly kind: string;
}

interface DumpedPullRequest {
  readonly number: number;
  readonly threads: readonly DumpedThread[];
  readonly conversation: readonly DumpedConversationEntry[];
}

interface ThreadsDump extends GithubRepository {
  readonly pullRequests: readonly DumpedPullRequest[];
}

const GITHUB_ANCHOR_PREFIX: Record<GithubFeedbackKind, string> = {
  thread: "discussion_r",
  comment: "issuecomment-",
  review: "pullrequestreview-",
};

function feedbackKey(kind: GithubFeedbackKind, pullRequestNumber: number, id: number): string {
  return `${kind} ${pullRequestNumber} ${id}`;
}

function githubLink(repository: GithubRepository, kind: GithubFeedbackKind, pullRequestNumber: number, id: number): string {
  return `https://${repository.host}/${repository.owner}/${repository.repo}/pull/${pullRequestNumber}#${GITHUB_ANCHOR_PREFIX[kind]}${id}`;
}

function isSentFromForgejo(comment: DumpedComment, textsSentFromForgejo: ReadonlySet<string>): boolean {
  return textsSentFromForgejo.has(withoutStagingRecords(comment.body ?? ""));
}

function isAutomatedAuthor(author: string): boolean {
  return author.endsWith(AUTOMATED_AUTHOR_SUFFIX);
}

function latestEntryIdPerAutomatedAuthor(conversation: readonly DumpedConversationEntry[]): Set<number> {
  const latest = new Map<string, number>();
  for (const entry of conversation) if (isAutomatedAuthor(entry.author)) latest.set(entry.author, entry.id);
  return new Set(latest.values());
}

function quotedComment(comment: DumpedComment): GithubFeedbackComment {
  return { author: comment.author, body: withoutStagingRecords(comment.body ?? "") };
}

function threadItems(
  repository: GithubRepository,
  pullRequest: DumpedPullRequest,
  textsSentFromForgejo: ReadonlySet<string>,
): GithubFeedbackItem[] {
  return pullRequest.threads
    .filter((thread) => thread.comments.length > 0)
    .map((thread) => {
      const first = thread.comments[0]!;
      return {
        key: feedbackKey(GITHUB_FEEDBACK_KIND.thread, pullRequest.number, first.id),
        kind: GITHUB_FEEDBACK_KIND.thread,
        pullRequestNumber: pullRequest.number,
        id: first.id,
        threadId: thread.id,
        resolved: thread.resolved,
        path: thread.path,
        line: thread.line ?? thread.originalLine,
        url: githubLink(repository, GITHUB_FEEDBACK_KIND.thread, pullRequest.number, first.id),
        comments: thread.comments.filter((comment) => !isSentFromForgejo(comment, textsSentFromForgejo)).map(quotedComment),
      };
    });
}

function conversationItems(
  repository: GithubRepository,
  pullRequest: DumpedPullRequest,
  textsSentFromForgejo: ReadonlySet<string>,
): GithubFeedbackItem[] {
  const latestAutomated = latestEntryIdPerAutomatedAuthor(pullRequest.conversation);
  return pullRequest.conversation
    .filter((entry) => !isSentFromForgejo(entry, textsSentFromForgejo))
    .filter((entry) => !isAutomatedAuthor(entry.author) || latestAutomated.has(entry.id))
    .map((entry) => {
      const kind = entry.kind === GITHUB_FEEDBACK_KIND.comment ? GITHUB_FEEDBACK_KIND.comment : GITHUB_FEEDBACK_KIND.review;
      return {
        key: feedbackKey(kind, pullRequest.number, entry.id),
        kind,
        pullRequestNumber: pullRequest.number,
        id: entry.id,
        threadId: null,
        resolved: false,
        path: null,
        line: null,
        url: githubLink(repository, kind, pullRequest.number, entry.id),
        comments: [quotedComment(entry)],
      };
    });
}

type DumpFeedback = (
  program: GithubProgram,
  pullRequest: { readonly host: string; readonly owner: string; readonly repo: string; readonly number: number },
  includeResolved: boolean,
) => ThreadsDump;

async function dumpGithubFeedback(githubUrl: string): Promise<ThreadsDump> {
  const target = parsePullRequestTarget(githubUrl);
  if (target.kind !== "url") throw new ForgeRefusal(`${githubUrl} is not a GitHub pull request URL.`);
  const threads = (await import(pathToFileURL(THREADS_SCRIPT_PATH).href)) as { dumpFeedback: DumpFeedback };
  try {
    const pullRequest = { host: target.host, owner: target.owner, repo: target.repository, number: target.number };
    return threads.dumpFeedback(githubProgramForHost(target.host), pullRequest, true);
  } catch (error) {
    throw new ForgeRefusal(`reading the review feedback on ${githubUrl} failed: ${messageOf(error)}`);
  }
}

export async function readGithubFeedback(githubUrl: string, textsSentFromForgejo: ReadonlySet<string>): Promise<GithubFeedback> {
  const dump = await dumpGithubFeedback(githubUrl);
  const repository = { host: dump.host, owner: dump.owner, repo: dump.repo };
  return {
    ...repository,
    items: dump.pullRequests.flatMap((pullRequest) => [
      ...threadItems(repository, pullRequest, textsSentFromForgejo),
      ...conversationItems(repository, pullRequest, textsSentFromForgejo),
    ]),
  };
}
