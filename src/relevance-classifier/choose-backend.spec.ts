import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASSIFIER_BACKEND_NAMES } from './classifier.types.ts';
import { chooseClassifierBackend, renderedBackendStatus } from './choose-backend.ts';
import { RULES_BACKEND } from './rules-backend.ts';

test('every relevance question is answered by the rules', async () => {
  assert.deepEqual(CLASSIFIER_BACKEND_NAMES, ['rules']);
  assert.equal(await chooseClassifierBackend(), RULES_BACKEND);
  assert.match(renderedBackendStatus(), /^backend that would answer now: rules\n/);
});
