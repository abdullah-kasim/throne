import { saveAttachmentToInbox } from './attachment-inbox.ts';
import { submittedPayload } from '../../herdr/herdr-send.helpers.ts';
import type {
  DeliveredEventStore,
  InboundMatrixMessage,
  MatrixSyncClient,
  PaneDeliveryService,
} from './bridge.types.ts';

export interface RunBridgeDeps {
  matrixClient: MatrixSyncClient;
  paneDelivery: PaneDeliveryService;
  deliveredEvents: DeliveredEventStore;
}

async function textWithAttachment(
  botName: string,
  message: InboundMatrixMessage,
  matrixClient: MatrixSyncClient,
): Promise<string> {
  if (message.attachment === undefined) return message.text;
  const downloaded = await matrixClient.downloadAttachment(
    message.attachment.mxcUri,
  );
  const path = await saveAttachmentToInbox(
    botName,
    message.eventId,
    downloaded,
    message.attachment.fileName,
  );
  return `${message.text} ${path}`;
}

export async function runBridge(
  botName: string,
  deps: RunBridgeDeps,
): Promise<void> {
  await deps.matrixClient.start(async (message) => {
    if (await deps.deliveredEvents.hasDelivered(message.eventId)) return;
    const text = await textWithAttachment(botName, message, deps.matrixClient);
    const composedText = submittedPayload(message.senderDisplayName, text, {});
    await deps.paneDelivery.deliverToPane(botName, composedText);
    await deps.deliveredEvents.markDelivered(message.eventId);
  });
}
