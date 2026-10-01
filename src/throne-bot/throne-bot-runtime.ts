import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MatrixClient } from 'matrix-bot-sdk';
import { loadBotConfig } from './bot-config.ts';
import {
  readBotCredentials,
  requireBotCredentials,
  writeBotCredentials,
  type BotCredentials,
} from './bot-credentials.ts';
import { createBotRoom } from './bot-room.ts';
import { listBots, type BotListing } from './list-bots.ts';
import { inferContentType, messageTypeForContentType } from './matrix-message.ts';
import { registerMatrixBotUser } from './matrix-registration.ts';

export interface ThroneBotRuntimeDeps {
  homeserverUrl: string;
  registrationToken: string;
  createClient(homeserverUrl: string, accessToken: string): MatrixClient;
  resolveBotsRoot(): Promise<string>;
  writeBotIdentity(botName: string): Promise<void>;
}

async function botDirectory(deps: ThroneBotRuntimeDeps, botName: string): Promise<string> {
  return path.join(await deps.resolveBotsRoot(), botName);
}

async function requireDepsBotCredentials(
  deps: ThroneBotRuntimeDeps,
  botName: string,
): Promise<BotCredentials> {
  const dir = await botDirectory(deps, botName);
  return requireBotCredentials(dir, botName);
}

export async function sayToBot(
  deps: ThroneBotRuntimeDeps,
  botName: string,
  text: string,
): Promise<string> {
  const credentials = await requireDepsBotCredentials(deps, botName);
  const client = deps.createClient(deps.homeserverUrl, credentials.accessToken);
  return client.sendText(credentials.roomId, text);
}

export async function sendFileToBot(
  deps: ThroneBotRuntimeDeps,
  botName: string,
  filePath: string,
): Promise<string> {
  const credentials = await requireDepsBotCredentials(deps, botName);
  const client = deps.createClient(deps.homeserverUrl, credentials.accessToken);
  const data = await readFile(filePath);
  const contentType = inferContentType(filePath);
  const fileName = path.basename(filePath);
  const mxcUri = await client.uploadContent(data, contentType, fileName);
  return client.sendMessage(credentials.roomId, {
    msgtype: messageTypeForContentType(contentType),
    body: fileName,
    url: mxcUri,
    info: { mimetype: contentType, size: data.length },
  });
}

export async function registerBot(
  deps: ThroneBotRuntimeDeps,
  botName: string,
): Promise<BotCredentials> {
  const dir = await botDirectory(deps, botName);
  const existing = await readBotCredentials(dir);
  if (existing !== undefined) return existing;

  const config = await loadBotConfig(dir);
  const anonymousClient = deps.createClient(deps.homeserverUrl, '');
  const registration = await registerMatrixBotUser(
    anonymousClient,
    botName,
    deps.registrationToken,
  );
  const authedClient = deps.createClient(deps.homeserverUrl, registration.accessToken);
  const roomId = await createBotRoom(authedClient, config.roomTitle);

  const credentials: BotCredentials = {
    homeserverUrl: deps.homeserverUrl,
    userId: registration.userId,
    accessToken: registration.accessToken,
    roomId,
    deviceId: registration.deviceId,
  };
  await writeBotCredentials(dir, credentials);
  await deps.writeBotIdentity(botName);
  return credentials;
}

export async function listRegisteredBots(deps: ThroneBotRuntimeDeps): Promise<BotListing[]> {
  return listBots(await deps.resolveBotsRoot());
}
