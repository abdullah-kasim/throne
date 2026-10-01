import path from 'node:path';
import { MatrixClient } from 'matrix-bot-sdk';
import { resolveLiveThroneRoot } from '../throne-root-resolution.ts';
import { writeIdentity } from '../agentdata/identity-data.service.ts';
import type { ThroneBotRuntimeDeps } from './throne-bot-runtime.ts';

const DEFAULT_HOMESERVER_URL = 'http://localhost:8008';

export const REAL_THRONE_BOT_DEPS: ThroneBotRuntimeDeps = {
  homeserverUrl: process.env.THRONE_BOT_HOMESERVER_URL ?? DEFAULT_HOMESERVER_URL,
  registrationToken: process.env.THRONE_BOT_REGISTRATION_TOKEN ?? '',
  createClient: (homeserverUrl, accessToken) => new MatrixClient(homeserverUrl, accessToken),
  resolveBotsRoot: async () => path.join(await resolveLiveThroneRoot(), 'bots'),
  writeBotIdentity: (botName) =>
    writeIdentity(botName, { role: 'Bot', supervisor: 'none', escalation: 'none' }),
};
