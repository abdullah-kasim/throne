import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdentityLineReadStatus } from '../agentdata/identity-data.service.ts';
import { run, type AddToQueueDeps } from './add-to-queue-runtime.ts';

function fakeDeps(role: string): { deps: AddToQueueDeps; insertedItems: unknown[] } {
  const insertedItems: unknown[] = [];
  const deps: AddToQueueDeps = {
    openStore: () => ({
      insertItem: (item: unknown) => {
        insertedItems.push(item);
        return { id: 'fake-item-1', status: 'open' };
      },
      close: () => {},
    }) as unknown as ReturnType<AddToQueueDeps['openStore']>,
    currentAgentName: async () => 'electronics-expert',
    readRole: async () => ({ status: IdentityLineReadStatus.Found, value: role }),
    resolveLaunchDefaults: () => {
      throw new Error('resolveLaunchDefaults should not be called when launch overrides are complete');
    },
    now: () => 1_700_000_000_000,
  };
  return { deps, insertedItems };
}

test('add-to-queue admits a Bot-role caller and inserts the queue item', async () => {
  const { deps, insertedItems } = fakeDeps('Bot');
  const exitCode = await run(
    [
      '--objective-code',
      'elw',
      '--alpha-name',
      'alpha-elw-electronics',
      '--target-repo',
      '/tmp/example-target',
      '--target-branch',
      'main',
      '--base-commit',
      '0123456789abcdef0123456789abcdef01234567',
      'INTENT:',
      'wire',
      'up',
      'the',
      'thing',
    ],
    deps,
  );
  assert.equal(exitCode, 0);
  assert.equal(insertedItems.length, 1);
});

test('add-to-queue refuses a Shadow-role caller', async () => {
  const { deps, insertedItems } = fakeDeps('Shadow');
  const exitCode = await run(
    [
      '--objective-code',
      'elw',
      '--target-repo',
      '/tmp/example-target',
      '--target-branch',
      'main',
      '--base-commit',
      '0123456789abcdef0123456789abcdef01234567',
      'INTENT:',
      'not',
      'admitted',
    ],
    deps,
  );
  assert.equal(exitCode, 1);
  assert.equal(insertedItems.length, 0);
});
