import { soleMessageId } from "../cancel-message/cancel-message.command.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import { senderAttributedPrompt } from "../herdr/herdr-send.helpers.ts";
import { resolveCurrentAgentName } from "../herdr/herdr-session.service.ts";
import {
  MESSAGE_RETENTION_WINDOW_MS,
  openMessageQueueStore,
  type MessageQueueStore,
} from "../message-queue/message-queue.store.ts";
import {
  MESSAGE_DELIVERY_WORK_ITEM_KIND,
  type MessageDeliveryWorkItemPayload,
} from "../send-agent/message-delivery-enqueue.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

export type StoredMessageReading =
  | { readonly outcome: "readable"; readonly text: string }
  | { readonly outcome: "no-longer-stored" }
  | { readonly outcome: "refused" };

export const READ_MESSAGE_EXIT = {
  Printed: 0,
  NotPrinted: 1,
} as const;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = MESSAGE_RETENTION_WINDOW_MS / MILLISECONDS_PER_DAY;

export function readStoredMessage(
  store: MessageQueueStore,
  messageId: number,
  callerName: string,
): StoredMessageReading {
  const item = store.readWorkItem(messageId);
  if (item === undefined || item.kind !== MESSAGE_DELIVERY_WORK_ITEM_KIND) {
    return { outcome: "no-longer-stored" };
  }
  const message = item.payload as MessageDeliveryWorkItemPayload;
  if (
    !sameAgentName(callerName, message.recipientName) &&
    !sameAgentName(callerName, message.senderName)
  ) {
    return { outcome: "refused" };
  }
  return {
    outcome: "readable",
    text: senderAttributedPrompt(
      message.senderName,
      message.prompt,
      message.omitSenderAttribution,
    ),
  };
}

export interface ReadMessageDependencies {
  openStore(): MessageQueueStore;
  resolveCurrentAgentName(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
}

const REAL_DEPENDENCIES: ReadMessageDependencies = {
  openStore: openMessageQueueStore,
  resolveCurrentAgentName,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function readStoredMessageOnce(
  dependencies: ReadMessageDependencies,
  messageId: number,
  callerName: string,
): StoredMessageReading {
  const store = dependencies.openStore();
  try {
    return readStoredMessage(store, messageId, callerName);
  } finally {
    store.close();
  }
}

export async function runReadMessage(
  args: readonly string[],
  dependencies: ReadMessageDependencies = REAL_DEPENDENCIES,
): Promise<number> {
  const messageId = soleMessageId(args);
  if (messageId === undefined) {
    dependencies.stderr(
      `read-message: Usage: throne read-message <message-id>\n${renderEntranceRefusal({
        reason: "read-message entrance validation requires exactly one message ID.",
        bypass: undefined,
        supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
      })}\n`,
    );
    return READ_MESSAGE_EXIT.NotPrinted;
  }
  const callerName = await dependencies.resolveCurrentAgentName();
  const reading = readStoredMessageOnce(dependencies, Number(messageId), callerName);
  switch (reading.outcome) {
    case "readable":
      dependencies.stdout(`${reading.text}\n`);
      return READ_MESSAGE_EXIT.Printed;
    case "no-longer-stored":
      dependencies.stderr(
        `read-message: message ${messageId} is no longer stored (rows are swept ${RETENTION_DAYS} days after they finish)\n`,
      );
      return READ_MESSAGE_EXIT.NotPrinted;
    case "refused":
      dependencies.stderr(
        `read-message: refused, message ${messageId} was neither sent by nor addressed to ${callerName}\n`,
      );
      return READ_MESSAGE_EXIT.NotPrinted;
  }
}
