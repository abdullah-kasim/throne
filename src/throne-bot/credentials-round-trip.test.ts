import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MatrixClient } from 'matrix-bot-sdk';
import { startFakeMatrixServer, type FakeMatrixServer } from './test-support/fake-matrix-server.ts';
import { registerBot, type ThroneBotRuntimeDeps } from './throne-bot-runtime.ts';
import { requireBotCredentials } from './bot-credentials.ts';

async function withFakeMatrixServer(
  run: (server: FakeMatrixServer, botsRoot: string) => Promise<void>,
): Promise<void> {
  const server = await startFakeMatrixServer();
  const botsRoot = await mkdtemp(path.join(os.tmpdir(), 'throne-bot-credentials-round-trip-'));
  try {
    await run(server, botsRoot);
  } finally {
    await server.close();
    await rm(botsRoot, { recursive: true, force: true });
  }
}

test('a bot registered by the CLI can be read by the bridge without a credentials mismatch', async () => {
  await withFakeMatrixServer(async (server, botsRoot) => {
    const deps: ThroneBotRuntimeDeps = {
      homeserverUrl: server.url,
      registrationToken: 'fake-token',
      createClient: (homeserverUrl, accessToken) => new MatrixClient(homeserverUrl, accessToken),
      resolveBotsRoot: async () => botsRoot,
      writeBotIdentity: async () => {},
    };
    const dir = path.join(botsRoot, 'electronics-expert');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'bot.json'),
      JSON.stringify({
        name: 'electronics-expert',
        displayName: 'Electronics Expert',
        roomTitle: 'Electronics Expert',
        skills: ['electronics'],
        model: 'claude/fable',
      }),
    );
    await writeFile(path.join(dir, 'persona.md'), 'A test persona.');

    const written = await registerBot(deps, 'electronics-expert');
    const readBack = await requireBotCredentials(dir, 'electronics-expert');

    assert.deepEqual(readBack, written);
    assert.equal(readBack.roomId, written.roomId);
    assert.equal(readBack.deviceId, written.deviceId);
  });
});
