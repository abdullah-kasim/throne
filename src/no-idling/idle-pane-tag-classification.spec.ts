// Requirement: the blocked marker must carry the child it waits on, so the
// no-idling sweep can check that child's existence mechanically.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyLastMessageTags } from './idle-pane-tag-classification.ts';

test('a blocked agent naming its dependency is classified with the exact named children', () => {
  const state = classifyLastMessageTags(
    'Waiting on shadow-abc and shadow-def, then I will merge.\n' +
      '{"blocked":true} __BLOCKED_BY_shadow-abc__ __BLOCKED_BY_shadow-def__',
  );
  assert.deepEqual(state, {
    kind: 'blocked',
    blockedBy: ['shadow-abc', 'shadow-def'],
  });
});

test('a bare {"blocked":true} with no named children classifies with an empty blockedBy list', () => {
  const state = classifyLastMessageTags('{"blocked":true}');
  assert.deepEqual(state, { kind: 'blocked', blockedBy: [] });
});
