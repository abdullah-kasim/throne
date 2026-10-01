import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MatrixClient } from 'matrix-bot-sdk';
import { startFakeMatrixServer, type FakeMatrixServer } from './test-support/fake-matrix-server.ts';
import {
  listRegisteredBots,
  registerBot,
  sayToBot,
  sendFileToBot,
  type ThroneBotRuntimeDeps,
} from './throne-bot-runtime.ts';

async function withFakeMatrixServer(
  run: (server: FakeMatrixServer, botsRoot: string, writtenIdentities: string[]) => Promise<void>,
): Promise<void> {
  const server = await startFakeMatrixServer();
  const botsRoot = await mkdtemp(path.join(os.tmpdir(), 'throne-bot-test-'));
  try {
    const writtenIdentities: string[] = [];
    await run(server, botsRoot, writtenIdentities);
  } finally {
    await server.close();
    await rm(botsRoot, { recursive: true, force: true });
  }
}

function testDeps(
  server: FakeMatrixServer,
  botsRoot: string,
  writtenIdentities: string[],
): ThroneBotRuntimeDeps {
  return {
    homeserverUrl: server.url,
    registrationToken: 'fake-token',
    createClient: (homeserverUrl, accessToken) => new MatrixClient(homeserverUrl, accessToken),
    resolveBotsRoot: async () => botsRoot,
    writeBotIdentity: async (botName) => {
      writtenIdentities.push(botName);
    },
  };
}

test('a bot can post a text message to its room', async () => {
  await withFakeMatrixServer(async (server, botsRoot, writtenIdentities) => {
    const deps = testDeps(server, botsRoot, writtenIdentities);
    const dir = path.join(botsRoot, 'electronics-expert');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'credentials.json'),
      JSON.stringify({
        homeserverUrl: server.url,
        userId: '@electronics-expert:test',
        accessToken: 'preset-token',
        roomId: '!existing:test',
        deviceId: 'DEV1',
      }),
    );

    const eventId = await sayToBot(deps, 'electronics-expert', 'hello room');
    assert.match(eventId, /^\$event-/);
  });
});

test('saying to an unregistered bot is refused with an actionable message', async () => {
  await withFakeMatrixServer(async (server, botsRoot, writtenIdentities) => {
    const deps = testDeps(server, botsRoot, writtenIdentities);
    await assert.rejects(
      () => sayToBot(deps, 'never-registered', 'hello'),
      /register-bot never-registered/,
    );
  });
});

test('a bot can send an image file and it is posted as m.image', async () => {
  await withFakeMatrixServer(async (server, botsRoot, writtenIdentities) => {
    const deps = testDeps(server, botsRoot, writtenIdentities);
    const dir = path.join(botsRoot, 'electronics-expert');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'credentials.json'),
      JSON.stringify({
        homeserverUrl: server.url,
        userId: '@electronics-expert:test',
        accessToken: 'preset-token',
        roomId: '!existing:test',
        deviceId: 'DEV1',
      }),
    );
    const imagePath = path.join(botsRoot, 'schematic.png');
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71]));

    const eventId = await sendFileToBot(deps, 'electronics-expert', imagePath);
    assert.match(eventId, /^\$event-/);
  });
});

test('a registration writes credentials at mode 0600', async () => {
  await withFakeMatrixServer(async (server, botsRoot, writtenIdentities) => {
    const deps = testDeps(server, botsRoot, writtenIdentities);
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

    const credentials = await registerBot(deps, 'electronics-expert');
    assert.equal(credentials.userId, '@electronics-expert:fake-matrix-server');
    assert.match(credentials.roomId, /^!room/);

    const credentialsPath = path.join(dir, 'credentials.json');
    const mode = (await stat(credentialsPath)).mode & 0o777;
    assert.equal(mode, 0o600);
    const onDisk = JSON.parse(await readFile(credentialsPath, 'utf8'));
    assert.deepEqual(onDisk, credentials);
    assert.deepEqual(writtenIdentities, ['electronics-expert']);
  });
});

test('registering an already-registered bot reuses its existing credentials instead of re-registering', async () => {
  await withFakeMatrixServer(async (server, botsRoot, writtenIdentities) => {
    const deps = testDeps(server, botsRoot, writtenIdentities);
    const dir = path.join(botsRoot, 'electronics-expert');
    await mkdir(dir, { recursive: true });
    const existingCredentials = {
      homeserverUrl: server.url,
      userId: '@electronics-expert:test',
      accessToken: 'already-there',
      roomId: '!already:test',
      deviceId: 'DEV1',
    };
    await writeFile(path.join(dir, 'credentials.json'), JSON.stringify(existingCredentials));

    const credentials = await registerBot(deps, 'electronics-expert');
    assert.deepEqual(credentials, existingCredentials);
    assert.deepEqual(writtenIdentities, []);
  });
});

test('listing bots reports each bot directory with its registration state', async () => {
  await withFakeMatrixServer(async (server, botsRoot, writtenIdentities) => {
    const deps = testDeps(server, botsRoot, writtenIdentities);
    await mkdir(path.join(botsRoot, 'electronics-expert'), { recursive: true });
    await writeFile(
      path.join(botsRoot, 'electronics-expert', 'bot.json'),
      JSON.stringify({
        name: 'electronics-expert',
        displayName: 'Electronics Expert',
        roomTitle: 'Electronics Expert',
        skills: ['electronics'],
        model: 'claude/fable',
      }),
    );
    await writeFile(
      path.join(botsRoot, 'electronics-expert', 'credentials.json'),
      JSON.stringify({ homeserverUrl: 'http://x', userId: 'x', accessToken: 'y', roomId: 'z', deviceId: 'd' }),
    );
    await mkdir(path.join(botsRoot, 'not-yet-registered'), { recursive: true });
    await writeFile(
      path.join(botsRoot, 'not-yet-registered', 'bot.json'),
      JSON.stringify({ name: 'not-yet-registered', roomTitle: 'Not Yet Registered' }),
    );

    const listings = await listRegisteredBots(deps);
    assert.deepEqual(listings, [
      { name: 'electronics-expert', registered: true },
      { name: 'not-yet-registered', registered: false },
    ]);
  });
});
