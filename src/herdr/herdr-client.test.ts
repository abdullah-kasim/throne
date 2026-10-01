import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  HerdrClientService,
  ownedHerdrClientPath,
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
      executablePath: path.join(root, 'data', 'throne', 'herdr', 'v0.8.2', 'herdr'),
      args: ['--session', THRONE_HERDR_SESSION_NAME, 'agent', 'list'],
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
