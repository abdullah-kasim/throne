import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface BotCredentials {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  roomId: string;
  deviceId: string;
}

export async function readBotCredentials(
  botDir: string,
): Promise<BotCredentials | undefined> {
  const credentialsPath = path.join(botDir, 'credentials.json');
  let raw: string;
  try {
    raw = await readFile(credentialsPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`credentials.json in "${botDir}" is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`credentials.json in "${botDir}" must be a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  const { homeserverUrl, accessToken, userId, roomId, deviceId } = record;
  if (
    typeof homeserverUrl !== 'string' ||
    typeof accessToken !== 'string' ||
    typeof userId !== 'string' ||
    typeof roomId !== 'string' ||
    typeof deviceId !== 'string' ||
    homeserverUrl === '' ||
    accessToken === '' ||
    userId === '' ||
    roomId === '' ||
    deviceId === ''
  ) {
    throw new Error(
      `credentials.json in "${botDir}" must carry non-empty string fields ` +
        `"homeserverUrl", "accessToken", "userId", "roomId", and "deviceId"`,
    );
  }
  return { homeserverUrl, accessToken, userId, roomId, deviceId };
}

export async function requireBotCredentials(botDir: string, botName: string): Promise<BotCredentials> {
  const credentials = await readBotCredentials(botDir);
  if (credentials === undefined) {
    throw new Error(
      `bot "${botName}" has no credentials.json — run "throne-bot register-bot ${botName}" first`,
    );
  }
  return credentials;
}

export async function writeBotCredentials(
  botDir: string,
  credentials: BotCredentials,
): Promise<void> {
  const filePath = path.join(botDir, 'credentials.json');
  await writeFile(filePath, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}
