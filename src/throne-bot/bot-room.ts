import type { MatrixClient } from 'matrix-bot-sdk';

export async function createBotRoom(
  client: MatrixClient,
  roomTitle: string,
): Promise<string> {
  return client.createRoom({
    name: roomTitle,
    visibility: 'private',
    preset: 'private_chat',
  });
}
