import {
  openMessageQueueStore,
  type MessageQueueStore,
} from "../message-queue/message-queue.store.ts";
import {
  buildMessageDeliveryWorkItemPayload,
  enqueueMessageDelivery,
} from "./message-delivery-enqueue.ts";

export interface SqliteScheduledSendRequest {
  readonly recipientName: string;
  readonly senderName: string;
  readonly prompt: string;
  readonly key?: string;
  readonly clearBlocked: boolean;
  readonly dueAtMs: number;
}

/** Persists one SQLite-backed scheduled delivery without applying delivery-time effects. */
export async function persistSqliteScheduledSend(
  request: SqliteScheduledSendRequest,
  openStore: () => MessageQueueStore = openMessageQueueStore,
): Promise<{ id: string }> {
  const store = openStore();
  try {
    const item = enqueueMessageDelivery(
      store,
      buildMessageDeliveryWorkItemPayload({
        recipientName: request.recipientName,
        recipientPaneId: "",
        senderName: request.senderName,
        prompt: request.prompt,
        ...(request.key === undefined ? {} : { key: request.key }),
        clearRecipientBlockedOnDelivery: request.clearBlocked,
        dueAtMs: request.dueAtMs,
      }),
    );
    return { id: String(item.id) };
  } finally {
    store.close();
  }
}
