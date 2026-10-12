import type { ForgejoApi } from "./forgejo-api.ts";
import { issueApiPath, pullRequestApiPath, type ForgejoPullRequestAddress } from "./forgejo-pull-requests.ts";
import { forgejoAnswerIn, githubFeedbackKeyIn } from "./staging-records.ts";

export const FEEDBACK_KIND = { reviewComment: "review-comment", comment: "comment", review: "review" } as const;
export type FeedbackKind = (typeof FEEDBACK_KIND)[keyof typeof FEEDBACK_KIND];

export interface FeedbackPlace {
  readonly path: string;
  readonly line: number;
  readonly onOldSide: boolean;
}

export interface ForgejoFeedbackItem {
  readonly id: number;
  readonly kind: FeedbackKind;
  readonly author: string;
  readonly place: FeedbackPlace | null;
  readonly reviewId: number | null;
  readonly resolved: boolean;
  readonly url: string;
  readonly body: string;
  readonly githubKey: string | null;
  readonly answers: number | null;
}

export interface ForgejoConversationComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
}

interface ForgejoUserRecord {
  readonly login: string;
}

interface ForgejoIssueCommentRecord {
  readonly id: number;
  readonly body: string;
  readonly user: ForgejoUserRecord | null;
  readonly html_url: string;
}

interface ForgejoReviewRecord {
  readonly id: number;
  readonly body: string;
  readonly user: ForgejoUserRecord | null;
  readonly html_url: string;
}

interface ForgejoReviewCommentRecord {
  readonly id: number;
  readonly body: string;
  readonly user: ForgejoUserRecord | null;
  readonly resolver: ForgejoUserRecord | null;
  readonly path: string;
  readonly position: number;
  readonly original_position: number;
  readonly html_url: string;
}

interface UnresolvedFeedbackItem extends Omit<ForgejoFeedbackItem, "resolved"> {
  readonly resolvedOnForgejo: boolean;
}

function itemOf(
  record: { readonly id: number; readonly body: string; readonly user: ForgejoUserRecord | null; readonly html_url: string },
  kind: FeedbackKind,
  place: FeedbackPlace | null,
  reviewId: number | null,
  resolvedOnForgejo: boolean,
): UnresolvedFeedbackItem {
  return {
    id: record.id,
    kind,
    author: record.user?.login ?? "unknown",
    place,
    reviewId,
    resolvedOnForgejo,
    url: record.html_url,
    body: record.body ?? "",
    githubKey: githubFeedbackKeyIn(record.body ?? "") ?? null,
    answers: forgejoAnswerIn(record.body ?? "")?.answers ?? null,
  };
}

function placeOf(comment: ForgejoReviewCommentRecord): FeedbackPlace {
  return comment.position > 0
    ? { path: comment.path, line: comment.position, onOldSide: false }
    : { path: comment.path, line: comment.original_position, onOldSide: true };
}

async function readReviewItems(address: ForgejoPullRequestAddress, api: ForgejoApi): Promise<UnresolvedFeedbackItem[]> {
  const reviews = await api.readJson<ForgejoReviewRecord[]>(`${pullRequestApiPath(address)}/reviews`);
  const items: UnresolvedFeedbackItem[] = [];
  for (const review of reviews) {
    if ((review.body ?? "").trim() !== "") {
      items.push(itemOf(review, FEEDBACK_KIND.review, null, null, false));
    }
    const comments = await api.readJson<ForgejoReviewCommentRecord[]>(`${pullRequestApiPath(address)}/reviews/${review.id}/comments`);
    for (const comment of comments) {
      items.push(itemOf(comment, FEEDBACK_KIND.reviewComment, placeOf(comment), review.id, comment.resolver !== null));
    }
  }
  return items;
}

function isResolved(item: UnresolvedFeedbackItem, items: readonly UnresolvedFeedbackItem[]): boolean {
  if (item.kind === FEEDBACK_KIND.reviewComment) return item.resolvedOnForgejo;
  return items.some((other) => other.answers === item.id && forgejoAnswerIn(other.body)?.resolves === true);
}

async function readConversationItems(address: ForgejoPullRequestAddress, api: ForgejoApi): Promise<UnresolvedFeedbackItem[]> {
  const conversation = await api.readJson<ForgejoIssueCommentRecord[]>(`${issueApiPath(address)}/comments`);
  return conversation.map((comment) => itemOf(comment, FEEDBACK_KIND.comment, null, null, false));
}

export async function readForgejoConversation(address: ForgejoPullRequestAddress, api: ForgejoApi): Promise<ForgejoConversationComment[]> {
  return (await readConversationItems(address, api)).map(({ id, author, body }) => ({ id, author, body }));
}

export async function readForgejoFeedback(address: ForgejoPullRequestAddress, api: ForgejoApi): Promise<ForgejoFeedbackItem[]> {
  const items = [...(await readConversationItems(address, api)), ...(await readReviewItems(address, api))];
  return items.map(({ resolvedOnForgejo, ...item }) => ({ ...item, resolved: isResolved({ resolvedOnForgejo, ...item }, items) }));
}

export async function postForgejoReviewComment(
  address: ForgejoPullRequestAddress,
  place: FeedbackPlace,
  body: string,
  api: ForgejoApi,
): Promise<void> {
  const line = place.onOldSide ? { old_position: place.line } : { new_position: place.line };
  await api.sendJson("POST", `${pullRequestApiPath(address)}/reviews`, {
    event: "COMMENT",
    body: "",
    comments: [{ path: place.path, body, ...line }],
  });
}

export async function postForgejoConversationComment(address: ForgejoPullRequestAddress, body: string, api: ForgejoApi): Promise<void> {
  await api.sendJson("POST", `${issueApiPath(address)}/comments`, { body });
}
