import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isQueueFilerRoleName } from './objective-contract.ts';

test('a Stager may file a queue objective', () => {
  assert.equal(isQueueFilerRoleName('Stager'), true);
});

test('a Bot may file a queue objective', () => {
  assert.equal(isQueueFilerRoleName('Bot'), true);
  assert.equal(isQueueFilerRoleName('bot'), true);
});

test('an Alpha may not file a queue objective', () => {
  assert.equal(isQueueFilerRoleName('Alpha'), false);
});

test('a Shadow may not file a queue objective', () => {
  assert.equal(isQueueFilerRoleName('Shadow'), false);
});
