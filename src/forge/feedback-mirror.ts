import { readStagedFeedback } from "./carry-answers-back.ts";
import { postForgejoConversationComment, postForgejoReviewComment } from "./forgejo-feedback.ts";
import { pullRequestApiPath } from "./forgejo-pull-requests.ts";
import type { GithubFeedbackItem } from "./github-feedback.ts";
import type { ForgeContext } from "./pull-request-operations.ts";
import { stagedPullRequestFor, type StagedPullRequest } from "./staged-pair.ts";
import { githubFeedbackRecord } from "./staging-records.ts";

export interface MirroredFeedback {
  readonly githubUrl: string;
  readonly twinUrl: string;
  readonly mirrored: readonly string[];
  readonly alreadyMirrored: readonly string[];
}

const NEW_FILE_HEADER = /^\+\+\+ b\/(.+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function linesShownInDiff(diff: string): Map<string, Set<number>> {
  const shown = new Map<string, Set<number>>();
  let lines: Set<number> | undefined;
  let nextLine = 0;
  for (const text of diff.split("\n")) {
    const file = NEW_FILE_HEADER.exec(text);
    const hunk = HUNK_HEADER.exec(text);
    if (file !== null) {
      lines = new Set();
      shown.set(file[1]!, lines);
    } else if (hunk !== null) {
      nextLine = Number(hunk[1]);
    } else if (lines !== undefined && (text.startsWith("+") || text.startsWith(" "))) {
      lines.add(nextLine);
      nextLine += 1;
    }
  }
  return shown;
}

function isLineStillInDiff(item: GithubFeedbackItem, shown: Map<string, Set<number>>): boolean {
  return item.path !== null && item.line !== null && shown.get(item.path)?.has(item.line) === true;
}

function quotedText(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

function mirroredBody(item: GithubFeedbackItem, placeNote: string): string {
  const quotedComments = item.comments.map((comment) => `**@${comment.author}** on GitHub:\n\n${quotedText(comment.body)}`);
  return [`${placeNote}[View on GitHub](${item.url})`, ...quotedComments, githubFeedbackRecord(item.key)].join("\n\n");
}

async function mirrorItem(staged: StagedPullRequest, item: GithubFeedbackItem, shown: Map<string, Set<number>>): Promise<void> {
  if (isLineStillInDiff(item, shown)) {
    const place = { path: item.path!, line: item.line!, onOldSide: false };
    await postForgejoReviewComment(staged.address, place, mirroredBody(item, ""), staged.api);
    return;
  }
  const placeNote = item.path === null ? "" : `On \`${item.path}\` line ${item.line}, which is no longer in this pull request's diff. `;
  await postForgejoConversationComment(staged.address, mirroredBody(item, placeNote), staged.api);
}

export async function mirrorFeedbackToTwin(context: ForgeContext, targetText: string): Promise<MirroredFeedback> {
  const staged = await stagedPullRequestFor(context, targetText);
  const { github, forgejoItems } = await readStagedFeedback(staged);
  const mirroredKeys = new Set(forgejoItems.map((item) => item.githubKey).filter((key) => key !== null));
  const shown = linesShownInDiff(await staged.api.readText(`${pullRequestApiPath(staged.address)}.diff`));
  const unresolved = github.items.filter((item) => !item.resolved && item.comments.length > 0);
  const mirrored: string[] = [];
  for (const item of unresolved.filter((candidate) => !mirroredKeys.has(candidate.key))) {
    await mirrorItem(staged, item, shown);
    mirrored.push(item.key);
  }
  return {
    githubUrl: staged.githubUrl,
    twinUrl: staged.url,
    mirrored,
    alreadyMirrored: unresolved.filter((item) => mirroredKeys.has(item.key)).map((item) => item.key),
  };
}
