import { readFile } from "node:fs/promises";
import { ForgeRefusal } from "./forge-refusal.ts";
import { postForgejoConversationComment, readForgejoFeedback, type ForgejoFeedbackItem } from "./forgejo-feedback.ts";
import {
  replyInForgejoReviewConversation,
  resolveForgejoReviewConversation,
  type ForgejoReviewConversation,
} from "./forgejo-review-conversations.ts";
import { signInToForgejoWebAsAdmin } from "./forgejo-web-session.ts";
import type { ForgeContext } from "./pull-request-operations.ts";
import { forgejoPullRequestFor, type ForgejoPullRequest } from "./staged-pair.ts";
import { forgejoAnswerRecord, withRecordAppended } from "./staging-records.ts";

export interface ForgejoAnswer {
  readonly answered: number;
  readonly resolved: boolean;
}

export interface AnswerRequest {
  readonly commentId: number;
  readonly bodyFile: string;
  readonly resolve: boolean;
}

async function feedbackItemOf(pullRequest: ForgejoPullRequest, commentId: number): Promise<ForgejoFeedbackItem> {
  const item = (await readForgejoFeedback(pullRequest.address, pullRequest.api)).find((candidate) => candidate.id === commentId);
  if (item === undefined) throw new ForgeRefusal(`${pullRequest.url} has no review comment or conversation comment ${commentId}.`);
  return item;
}

function reviewConversationOf(item: ForgejoFeedbackItem): ForgejoReviewConversation | null {
  return item.place === null || item.reviewId === null ? null : { reviewId: item.reviewId, place: item.place };
}

async function confirmResolved(pullRequest: ForgejoPullRequest, commentId: number): Promise<void> {
  if (!(await feedbackItemOf(pullRequest, commentId)).resolved) {
    throw new ForgeRefusal(`Forgejo accepted the resolution of comment ${commentId} on ${pullRequest.url}, but re-reading it shows it unresolved.`);
  }
}

export async function listForgejoFeedback(context: ForgeContext, targetText: string): Promise<ForgejoFeedbackItem[]> {
  const pullRequest = await forgejoPullRequestFor(context, targetText);
  return readForgejoFeedback(pullRequest.address, pullRequest.api);
}

export async function answerForgejoFeedback(context: ForgeContext, targetText: string, request: AnswerRequest): Promise<ForgejoAnswer> {
  const pullRequest = await forgejoPullRequestFor(context, targetText);
  const item = await feedbackItemOf(pullRequest, request.commentId);
  const answer = forgejoAnswerRecord({ answers: item.id, resolves: request.resolve });
  const body = withRecordAppended(await readFile(request.bodyFile, "utf8"), answer);
  const conversation = reviewConversationOf(item);
  if (conversation !== null) {
    const session = await signInToForgejoWebAsAdmin(pullRequest.api, context.dependencies);
    await replyInForgejoReviewConversation(pullRequest.address, conversation, body, session);
    if (request.resolve) await resolveForgejoReviewConversation(pullRequest.address, item.id, session);
  } else {
    await postForgejoConversationComment(pullRequest.address, body, pullRequest.api);
  }
  if (request.resolve) await confirmResolved(pullRequest, item.id);
  return { answered: item.id, resolved: request.resolve };
}
