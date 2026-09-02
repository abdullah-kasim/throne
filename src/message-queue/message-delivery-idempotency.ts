import { createHash } from "node:crypto";

export const MESSAGE_DELIVERY_RETRY_DEDUP_BUCKET_MS = 60_000;

export interface MessageDeliveryIdentity {
  readonly recipientName: string;
  readonly senderName: string;
  readonly prompt: string;
}

export function deriveDefaultMessageDeliveryIdempotencyKey(
  fields: MessageDeliveryIdentity,
  nowMs: number,
  bucketMs: number = MESSAGE_DELIVERY_RETRY_DEDUP_BUCKET_MS,
): string {
  const bucket = Math.floor(nowMs / bucketMs);
  const digest = createHash("sha256")
    .update(`${fields.recipientName} ${fields.senderName} ${fields.prompt} ${bucket}`)
    .digest("hex");
  return `auto-${digest}`;
}

export function deriveScheduledMessageDeliveryIdempotencyKey(
  fields: MessageDeliveryIdentity & { readonly dueAtMs: number },
  key?: string,
): string {
  const identity = key ?? `${fields.recipientName}\n${fields.senderName}\n${fields.prompt}`;
  const digest = createHash("sha256")
    .update(`${identity}\n${fields.dueAtMs}`)
    .digest("hex");
  return `scheduled-${digest}`;
}
