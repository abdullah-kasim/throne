import { ForgeRefusal } from "./forge-refusal.ts";
import type { FeedbackPlace } from "./forgejo-feedback.ts";
import type { ForgejoPullRequestAddress } from "./forgejo-pull-requests.ts";
import type { ForgejoWebSession } from "./forgejo-web-session.ts";

const CONVERSATION_SHOWN_IN = "timeline";
const DIFF_SIDE = { old: "previous", new: "proposed" } as const;

export interface ForgejoReviewConversation {
  readonly reviewId: number;
  readonly place: FeedbackPlace;
}

function pullRequestWebPath(address: ForgejoPullRequestAddress): string {
  return `${encodeURIComponent(address.repository.owner)}/${encodeURIComponent(address.repository.name)}/pulls`;
}

async function postOrRefuse(session: ForgejoWebSession, webPath: string, fields: Record<string, string>, failure: string): Promise<void> {
  const response = await session.postForm(webPath, fields);
  if (!response.ok) throw new ForgeRefusal(`Forgejo POST ${session.rootUrl}${webPath} answered HTTP ${response.status}; ${failure}`);
}

export async function replyInForgejoReviewConversation(
  address: ForgejoPullRequestAddress,
  conversation: ForgejoReviewConversation,
  body: string,
  session: ForgejoWebSession,
): Promise<void> {
  await postOrRefuse(
    session,
    `${pullRequestWebPath(address)}/${address.number}/files/reviews/comments`,
    {
      origin: CONVERSATION_SHOWN_IN,
      content: body,
      path: conversation.place.path,
      line: String(conversation.place.line),
      side: conversation.place.onOldSide ? DIFF_SIDE.old : DIFF_SIDE.new,
      single_review: "true",
      reply: String(conversation.reviewId),
    },
    `the answer was not posted in review ${conversation.reviewId}'s conversation.`,
  );
}

export async function resolveForgejoReviewConversation(
  address: ForgejoPullRequestAddress,
  commentId: number,
  session: ForgejoWebSession,
): Promise<void> {
  await postOrRefuse(
    session,
    `${pullRequestWebPath(address)}/resolve_conversation`,
    { origin: CONVERSATION_SHOWN_IN, action: "Resolve", comment_id: String(commentId) },
    `comment ${commentId}'s conversation is not resolved.`,
  );
}
