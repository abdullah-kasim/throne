import { Injectable, Optional } from "@nestjs/common";
import { CronExpression } from "@nestjs/schedule";
import { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { agentAlive } from "../herdr/delivery-request-client.ts";
import {
  MessageQueueWorkItemState,
  openMessageQueueStore,
  type MessageQueueStore,
  type WorkItemRow,
} from "../message-queue/message-queue.store.ts";
import {
  MESSAGE_DELIVERY_WORK_ITEM_KIND,
  type MessageDeliveryWorkItemPayload,
} from "../send-agent/message-delivery-enqueue.ts";
import { errorText } from "../shared-policy/error-text.ts";
import type { CronHostedWorker } from "./hosted-worker.types.ts";

export const LOST_ACCEPTED_MESSAGE_HOSTED_WORKER_NAME = "lost-accepted-message";

export const LOST_ACCEPTED_MESSAGE_REASON =
  "the agent stopped answering while it held the accepted message; the message is queued again";

@Injectable()
export class LostAcceptedMessageHostedWorker implements CronHostedWorker {
  readonly kind = "cron" as const;
  readonly workerName = LOST_ACCEPTED_MESSAGE_HOSTED_WORKER_NAME;
  readonly cronExpression = CronExpression.EVERY_MINUTE;

  constructor(
    @Optional() private readonly store: MessageQueueStore = openMessageQueueStore(),
    @Optional() private readonly spawnRecordsDirectory?: string,
  ) {}

  async runOnce(): Promise<void> {
    const acceptedMessages = this.store
      .listWorkItemsByStates([MessageQueueWorkItemState.Accepted])
      .filter((row) => row.kind === MESSAGE_DELIVERY_WORK_ITEM_KIND);
    for (const message of acceptedMessages) {
      try {
        await this.requeueIfItsAgentIsGone(message);
      } catch (error) {
        process.stderr.write(`${LOST_ACCEPTED_MESSAGE_HOSTED_WORKER_NAME}: message ${message.id} could not be checked: ${errorText(error)}\n`);
      }
    }
  }

  private async requeueIfItsAgentIsGone(message: WorkItemRow): Promise<void> {
    const { recipientName, recipientPaneId } = message.payload as MessageDeliveryWorkItemPayload;
    const socketPath = (await readSpawnSpec(recipientName, this.spawnRecordsDirectory))?.delivery_socket;
    if ((await agentAlive(socketPath, recipientPaneId)) !== undefined) return;
    this.store.requeueLostAcceptedWorkItem(message.id, LOST_ACCEPTED_MESSAGE_REASON);
  }
}
