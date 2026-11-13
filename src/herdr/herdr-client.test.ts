import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  HerdrClientService,
  HerdrCommandError,
  HerdrCompatibilityError,
  OWNED_HERDR_CLIENT_RELEASE_TAG,
  ownedHerdrClientPath,
  THRONE_HERDR_PROTOCOL,
  THRONE_HERDR_SESSION_NAME,
} from './herdr-client.ts';

test('throne always talks to its own pinned herdr in the throne session, with no features file at all', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-client-'));
  try {
    const environment = {
      XDG_CONFIG_HOME: path.join(root, 'config-without-features-file'),
      XDG_DATA_HOME: path.join(root, 'data'),
    };
    const invocations: { executablePath: string; args: readonly string[] }[] = [];
    const client = new HerdrClientService({
      ownedHerdrClientPath: () => ownedHerdrClientPath(environment, root),
      executeHerdrReadOnly: async (executablePath, args) => {
        invocations.push({ executablePath, args });
        return { stdout: '{}', stderr: '' };
      },
    });

    await client.execute(['agent', 'list']);

    assert.deepEqual(invocations, [{
      executablePath: path.join(root, 'data', 'throne', 'herdr', OWNED_HERDR_CLIENT_RELEASE_TAG, 'herdr'),
      args: ['--session', THRONE_HERDR_SESSION_NAME, 'agent', 'list'],
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function clientAnsweringStatus(serverStatus: object) {
  const invocations: (readonly string[])[] = [];
  const client = new HerdrClientService({
    ownedHerdrClientPath: () => '/pinned/herdr',
    executeHerdrReadOnly: async (_executablePath, args) => {
      invocations.push(args);
      if (args.includes('--version')) {
        return { stdout: `herdr ${OWNED_HERDR_CLIENT_RELEASE_TAG.slice(1)}\n`, stderr: '' };
      }
      return { stdout: JSON.stringify(serverStatus), stderr: '' };
    },
  });
  return { client, invocations };
}

const runningPinnedServer = {
  status: 'running',
  running: true,
  version: OWNED_HERDR_CLIENT_RELEASE_TAG.slice(1),
  protocol: Number(THRONE_HERDR_PROTOCOL),
  compatible: true,
  endpoint_compatible: true,
  socket: `/home/someone/.config/herdr/sessions/${THRONE_HERDR_SESSION_NAME}/herdr.sock`,
  session: THRONE_HERDR_SESSION_NAME,
};

test('a running pinned herdr server passes the compatibility check from its json status', async () => {
  const { client, invocations } = clientAnsweringStatus(runningPinnedServer);

  await client.preflightCompatibility();

  assert.deepEqual(invocations, [
    ['--session', THRONE_HERDR_SESSION_NAME, '--version'],
    ['--session', THRONE_HERDR_SESSION_NAME, 'status', 'server', '--json'],
  ]);
});

test('a herdr server on another protocol is refused as incompatible', async () => {
  const { client } = clientAnsweringStatus({ ...runningPinnedServer, protocol: Number(THRONE_HERDR_PROTOCOL) - 1 });

  await assert.rejects(client.preflightCompatibility(), HerdrCompatibilityError);
});

test('a herdr server whose socket is outside the throne session is refused as incompatible', async () => {
  const { client } = clientAnsweringStatus({ ...runningPinnedServer, socket: '/home/someone/.config/herdr/herdr.sock' });

  await assert.rejects(client.preflightCompatibility(), HerdrCompatibilityError);
});

async function pinnedHerdrServing(answer: (args: readonly string[]) => { stdout: string; stderr: string } | Error) {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-remembered-'));
  const binaryPath = path.join(root, 'herdr');
  await writeFile(binaryPath, 'herdr 0.9.5');
  const checks: (readonly string[])[] = [];
  const client = new HerdrClientService({
    ownedHerdrClientPath: () => binaryPath,
    executeHerdrReadOnly: async (_executablePath, args) => {
      if (args.includes('--version')) {
        checks.push(args);
        return { stdout: `herdr ${OWNED_HERDR_CLIENT_RELEASE_TAG.slice(1)}\n`, stderr: '' };
      }
      if (args.includes('status')) return { stdout: JSON.stringify(runningPinnedServer), stderr: '' };
      const reply = answer(args);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  return { client, checks, binaryPath, cleanUp: () => rm(root, { recursive: true, force: true }) };
}

const sendKeys = ['pane', 'send-keys', 'pane-1', 'Enter'];

test("herdr's compatibility is checked once for many herdr calls", async () => {
  const herdr = await pinnedHerdrServing(() => ({ stdout: '', stderr: '' }));
  try {
    for (let call = 0; call < 5; call += 1) await herdr.client.run(sendKeys);
    assert.equal(herdr.checks.length, 1);
  } finally {
    await herdr.cleanUp();
  }
});

test('a new herdr version is checked again', async () => {
  const herdr = await pinnedHerdrServing(() => ({ stdout: '', stderr: '' }));
  try {
    await herdr.client.run(sendKeys);
    await writeFile(herdr.binaryPath, 'herdr 0.9.6 with a different body');
    await herdr.client.run(sendKeys);
    assert.equal(herdr.checks.length, 2);
  } finally {
    await herdr.cleanUp();
  }
});

test('a herdr failure that says the server changed makes the next call check again', async () => {
  let serverStopped = false;
  const herdr = await pinnedHerdrServing((args) =>
    serverStopped && args.includes('list')
      ? new HerdrCommandError(args, 'server not running', { code: 'server_not_running' })
      : { stdout: '', stderr: '' });
  try {
    await herdr.client.run(sendKeys);
    serverStopped = true;
    await assert.rejects(herdr.client.run(['agent', 'list']), HerdrCommandError);
    serverStopped = false;
    await herdr.client.run(sendKeys);
    assert.equal(herdr.checks.length, 2);
  } finally {
    await herdr.cleanUp();
  }
});

test('a herdr failure about one pane keeps the remembered compatibility', async () => {
  const herdr = await pinnedHerdrServing((args) =>
    args.includes('gone-pane')
      ? new HerdrCommandError(args, 'pane not found', { code: 'pane_not_found' })
      : { stdout: '', stderr: '' });
  try {
    await herdr.client.run(sendKeys);
    await assert.rejects(herdr.client.run(['pane', 'send-keys', 'gone-pane', 'Enter']), HerdrCommandError);
    await herdr.client.run(sendKeys);
    assert.equal(herdr.checks.length, 1);
  } finally {
    await herdr.cleanUp();
  }
});

test('a foreign herdr server is still refused on every call', async () => {
  const { client, invocations } = clientAnsweringStatus({ ...runningPinnedServer, socket: '/home/someone/.config/herdr/herdr.sock' });

  await assert.rejects(client.run(sendKeys), HerdrCompatibilityError);
  await assert.rejects(client.run(sendKeys), HerdrCompatibilityError);
  assert.equal(invocations.filter((args) => args.includes('--version')).length, 2);
});
