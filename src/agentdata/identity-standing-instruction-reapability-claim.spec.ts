// Requirement: an Alpha's generated opening prompt tells it that a
// reapability claim is required for teardown and gives its exact literal
// shape; a Shadow's generated opening prompt is unaffected by that section
// (it already carries its own, different completion mechanism).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composeOpeningPrompt } from './identity-data.service.ts';
import { formatReapabilityClaim } from '../reap-agent/reapability-claim.ts';

test('an Alpha\'s generated opening prompt tells it a reapability claim is required for teardown and gives its exact literal shape', () => {
  const prompt = composeOpeningPrompt('alpha-test', {
    supervisor: 'Regent',
    escalation: 'Regent',
    role: 'Alpha',
  });

  assert.match(prompt, /reap-agent/);
  assert.ok(
    prompt.includes(formatReapabilityClaim('completed')),
    'the prompt cites the real formatReapabilityClaim("completed") output, not a hand-typed JSON string',
  );
});

test('a Shadow\'s generated opening prompt is unaffected by the new Alpha-only reapability-claim section', () => {
  const prompt = composeOpeningPrompt('shadow-test', {
    supervisor: 'alpha-test',
    escalation: 'Regent',
    role: 'Shadow',
  });

  assert.ok(
    !prompt.includes(formatReapabilityClaim('completed')),
    'a Shadow prompt should not gain the Alpha-only reapability-claim section',
  );
});
