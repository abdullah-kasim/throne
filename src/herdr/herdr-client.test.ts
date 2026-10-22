import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  HerdrClientService,
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
