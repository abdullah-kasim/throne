import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { MESSAGE_DELIVERY_WORK_ITEM_KIND } from "../send-agent/message-delivery-enqueue.ts";
import { openMessageQueueStore, type MessageQueueStore, type WorkItemRow } from "./message-queue.store.ts";

export const RECIPIENT_NAME = "shadow-invented-01";
export const RECIPIENT_PANE = "w9:p9";
export const SENDER_NAME = "alpha-invented-01";

export interface AcceptedMessageScratch {
  readonly folder: string;
  readonly databasePath: string;
  readonly spawnRecordsDirectory: string;
  readonly store: MessageQueueStore;
  remove(): Promise<void>;
}

export async function acceptedMessageScratch(): Promise<AcceptedMessageScratch> {
  const folder = await mkdtemp(path.join(tmpdir(), "accepted-"));
  const databasePath = path.join(folder, "queue.sqlite3");
  const store = openMessageQueueStore(databasePath);
  return {
    folder,
    databasePath,
    spawnRecordsDirectory: path.join(folder, "data"),
    store,
    async remove() {
      store.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

export async function recordRecipient(scratch: AcceptedMessageScratch, deliverySocket: string): Promise<void> {
  await writeSpawnSpec(
    RECIPIENT_NAME,
    {
      harness: "claude",
      model: "opus",
      effort: 3,
      cwd: scratch.folder,
      delivery_socket: deliverySocket,
    },
    scratch.spawnRecordsDirectory,
  );
}

export function insertAcceptedMessage(store: MessageQueueStore): WorkItemRow {
  const queued = store.insertWorkItem({
    kind: MESSAGE_DELIVERY_WORK_ITEM_KIND,
    payload: {
      recipientName: RECIPIENT_NAME,
      recipientPaneId: RECIPIENT_PANE,
      senderName: SENDER_NAME,
      prompt: "an invented message",
      clearRecipientBlockedOnDelivery: false,
    },
  });
  store.claimDueWorkItem(queued.id);
  return store.acceptInFlightWorkItem(queued.id);
}
