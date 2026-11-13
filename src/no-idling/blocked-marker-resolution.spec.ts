import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readDeclaredTag } from './blocked-marker-resolution.ts';
import { declaredState } from './no-idling-command-test-fixtures.ts';

test('the tag no-idling decides from comes from the state file alone', async () => {
  const cases = [
    [declaredState('blocked', { blockedBy: ['shadow-1'] }), { kind: 'blocked', blockedBy: ['shadow-1'] }],
    [declaredState('waiting-on-own-run'), { kind: 'blocked', blockedBy: [], waitsOnOwnBackgroundRun: true }],
    [declaredState('waiting-on-supervisor'), { kind: 'blocked', blockedBy: [] }],
    [declaredState('reapable', { reapableReason: 'completed' }), { kind: 'reapable' }],
    [declaredState('reapable', { reapableReason: 'fail: the suite is red' }), { kind: 'reapable-failed' }],
    [declaredState('working'), { kind: 'unmarked' }],
  ] as const;
  for (const [declared, expected] of cases) {
    assert.deepEqual(await readDeclaredTag('shadow-bakery-01-oven', async () => declared), expected, declared.state);
  }
});

test('a working agent with running tool work is busy, and a blocked one stays blocked while it runs', async () => {
  const running = async () => 'sh ./hold.sh';

  assert.deepEqual(await readDeclaredTag('shadow-a', async () => declaredState('working'), running), {
    kind: 'busy',
    running: 'sh ./hold.sh',
  });
  assert.equal((await readDeclaredTag('shadow-a', async () => declaredState('blocked'), running)).kind, 'blocked');
});

test('a state file that cannot be read is reported as unreadable', async () => {
  const state = await readDeclaredTag('shadow-a', async () => {
    throw new Error('disk is gone');
  });

  assert.deepEqual(state, { kind: 'unreadable' });
});
