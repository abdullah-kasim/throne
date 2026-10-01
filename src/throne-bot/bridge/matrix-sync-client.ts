import { join } from 'node:path';
import {
  AutojoinRoomsMixin,
  MatrixClient,
  SimpleFsStorageProvider,
} from 'matrix-bot-sdk';
import type { BotCredentials } from '../bot-credentials.ts';
import type { InboundMatrixMessage, MatrixSyncClient } from './bridge.types.ts';

const ATTACHMENT_MSGTYPES = new Set(['m.image', 'm.file', 'm.audio', 'm.video']);

async function resolveSenderDisplayName(
  client: MatrixClient,
  senderId: string,
): Promise<string> {
  try {
    const profile: unknown = await client.getUserProfile(senderId);
    if (
      typeof profile === 'object' &&
      profile !== null &&
      'displayname' in profile &&
      typeof (profile as { displayname?: unknown }).displayname === 'string' &&
      (profile as { displayname: string }).displayname !== ''
    ) {
      return (profile as { displayname: string }).displayname;
    }
  } catch {
    return senderId;
  }
  return senderId;
}

export function createMatrixSyncClient(
  credentials: BotCredentials,
  storageDir: string,
): MatrixSyncClient {
  const storage = new SimpleFsStorageProvider(
    join(storageDir, 'matrix-sync-state.json'),
  );
  const client = new MatrixClient(
    credentials.homeserverUrl,
    credentials.accessToken,
    storage,
  );
  AutojoinRoomsMixin.setupOnClient(client);

  return {
    async start(onMessage): Promise<void> {
      client.on(
        'room.message',
        (roomId: string, event: Record<string, unknown>) => {
          void handleRoomMessage(client, credentials, roomId, event, onMessage);
        },
      );
      await client.start();
    },
    async downloadAttachment(mxcUri: string) {
      const downloaded = await client.downloadContent(mxcUri);
      return { data: downloaded.data, contentType: downloaded.contentType };
    },
  };
}

async function handleRoomMessage(
  client: MatrixClient,
  credentials: BotCredentials,
  roomId: string,
  event: Record<string, unknown>,
  onMessage: (message: InboundMatrixMessage) => Promise<void>,
): Promise<void> {
  const sender = event.sender;
  if (typeof sender !== 'string' || sender === credentials.userId) return;
  const eventId = event.event_id;
  if (typeof eventId !== 'string') return;
  const content = event.content;
  if (typeof content !== 'object' || content === null) return;
  const contentRecord = content as Record<string, unknown>;
  const body = contentRecord.body;
  if (typeof body !== 'string') return;
  const msgtype = contentRecord.msgtype;
  const senderDisplayName = await resolveSenderDisplayName(client, sender);

  let attachment: InboundMatrixMessage['attachment'];
  if (typeof msgtype === 'string' && ATTACHMENT_MSGTYPES.has(msgtype)) {
    const url = contentRecord.url;
    if (typeof url === 'string') {
      attachment = { mxcUri: url, fileName: body };
    }
  }

  await onMessage({
    eventId,
    roomId,
    senderId: sender,
    senderDisplayName,
    text: body,
    attachment,
  });
}
