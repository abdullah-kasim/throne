import type { MessageQueueStore, WorkItemRow } from "../message-queue/message-queue.store.ts";
import {
  MESSAGE_DELIVERY_WORK_ITEM_KIND,
  enqueueMessageDelivery,
  type MessageDeliveryWorkItemPayload,
} from "../send-agent/message-delivery-enqueue.ts";

export const READ_MESSAGE_COMMAND_LINE = "throne read-message";

export type UndeliveredMessageVerdict = "truncated" | "absent";

export interface UndeliveredMessage {
  readonly messageId: number;
  readonly senderName: string;
  readonly recipientName: string;
  readonly recipientPaneId: string;
}

const DELIVERY_NOTICE_OPENINGS: Record<
  UndeliveredMessageVerdict,
  (messageId: number, senderName: string) => string
> = {
  truncated: (messageId, senderName) =>
    `Message ${messageId} from ${senderName} reached you cut short. ` +
    "Disregard what you did from the fragment and read the full text:",
  absent: (messageId, senderName) =>
    `Message ${messageId} from ${senderName} may not have reached you. Read it:`,
};

const UNNAMED_SENDER_NOTICE_NAME = "the throne";

function noticeSenderName(senderName: string): string {
  return senderName.trim().length === 0 ? UNNAMED_SENDER_NOTICE_NAME : senderName;
}

export function buildDeliveryNotice(
  verdict: UndeliveredMessageVerdict,
  messageId: number,
  senderName: string,
): string {
  const opening = DELIVERY_NOTICE_OPENINGS[verdict](messageId, noticeSenderName(senderName));
  return `${opening} ${READ_MESSAGE_COMMAND_LINE} ${messageId}`;
}

export function deliveryNoticeDedupeKey(messageId: number): string {
  return `delivery-notice:${messageId}`;
}

export function isDeliveryNotice(item: WorkItemRow): boolean {
  const payload = item.payload as Partial<MessageDeliveryWorkItemPayload> | null;
  return payload?.deliveryNotice === true;
}

export function enqueueDeliveryNotice(
  store: MessageQueueStore,
  message: UndeliveredMessage,
  verdict: UndeliveredMessageVerdict,
): WorkItemRow | undefined {
  const dedupeKey = deliveryNoticeDedupeKey(message.messageId);
  return store.insertUnlessDedupeKeyIsStored(
    MESSAGE_DELIVERY_WORK_ITEM_KIND,
    dedupeKey,
    () =>
      enqueueMessageDelivery(store, {
        recipientName: message.recipientName,
        recipientPaneId: message.recipientPaneId,
        senderName: message.senderName,
        prompt: buildDeliveryNotice(verdict, message.messageId, message.senderName),
        key: dedupeKey,
        clearRecipientBlockedOnDelivery: false,
        omitSenderAttribution: true,
        disableFileBackedDelivery: true,
        deliveryNotice: true,
      }),
  );
}
