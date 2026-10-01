import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintObjectiveBody } from './lint-objective.ts';

test('an objective ending with the literal DONE completion callback is accepted', () => {
  const body = [
    'INTENT: fix the widget',
    '',
    '1. Read the code.',
    '2. Fix the bug.',
    'throne send-agent electronics-expert "DONE elw: fixed the widget crash"',
  ].join('\n');
  assert.deepEqual(lintObjectiveBody(body), { ok: true });
});

test('an objective missing the DONE final step is rejected', () => {
  const body = [
    'INTENT: fix the widget',
    '',
    '1. Read the code.',
    '2. Fix the bug.',
  ].join('\n');
  const result = lintObjectiveBody(body);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /literal completion callback/);
});

test('an objective whose last step is the callback text but not in the final position is rejected', () => {
  const body = [
    'throne send-agent electronics-expert "DONE elw: fixed the widget crash"',
    '',
    'One more step after the callback.',
  ].join('\n');
  assert.equal(lintObjectiveBody(body).ok, false);
});

test('an empty objective body is rejected', () => {
  const result = lintObjectiveBody('   \n\n  ');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /empty/);
});
