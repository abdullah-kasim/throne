import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { argvSeenByRealBinary, createGhGuardSandbox, runGuard } from './support/gh-guard-sandbox.support.ts';

test('ghe reaches the real ghe for a read the guard allows', async () => {
  const box = await createGhGuardSandbox();
  const result = await runGuard(box, 'ghe', ['pr', 'view', '1']);
  assert.equal(result.code, 0);
  assert.deepEqual(await argvSeenByRealBinary(box), ['pr', 'view', '1']);
});

test('ghe is denied the mutations gh is denied, and says ghe in the refusal', async () => {
  const box = await createGhGuardSandbox();
  const result = await runGuard(box, 'ghe', ['pr', 'merge', '1', '--squash']);
  assert.equal(result.code, 64);
  assert.match(result.stderr, /denied GitHub mutation or unclassified command: ghe pr merge 1 --squash/);
  await assert.rejects(() => readFile(box.argvLog, 'utf8'));
});

test('ghe honours an explicit --bypass as its first argument', async () => {
  const box = await createGhGuardSandbox();
  const result = await runGuard(box, 'ghe', ['--bypass', 'pr', 'merge', '1']);
  assert.equal(result.code, 0);
  assert.deepEqual(await argvSeenByRealBinary(box), ['pr', 'merge', '1']);
});

test('a bypass granted to gh survives a gh shim that routes to ghe', async () => {
  const box = await createGhGuardSandbox({ ghRoutesToGhe: true });
  const result = await runGuard(box, 'gh', ['--bypass', 'pr', 'merge', '1']);
  assert.equal(result.code, 0);
  assert.deepEqual(await argvSeenByRealBinary(box), ['pr', 'merge', '1']);
  assert.match(result.stderr, /BYPASSED by an outer guard's --bypass: ghe pr merge 1/);
});

test('a gh shim that routes to ghe is still judged when no bypass was granted', async () => {
  const box = await createGhGuardSandbox({ ghRoutesToGhe: true });
  const result = await runGuard(box, 'gh', ['pr', 'merge', '1']);
  assert.equal(result.code, 64);
  await assert.rejects(() => readFile(box.argvLog, 'utf8'));
});

test('ghe without a real ghe anywhere on PATH refuses instead of falling back to gh', async () => {
  const box = await createGhGuardSandbox({ withRealGhe: false });
  const result = await runGuard(box, 'ghe', ['pr', 'view', '1']);
  assert.equal(result.code, 127);
  assert.match(result.stderr, /real ghe binary not found/);
});

test('gh keeps judging its own commands under its own name', async () => {
  const box = await createGhGuardSandbox();
  assert.equal((await runGuard(box, 'gh', ['pr', 'view', '1'])).code, 0);
  const denied = await runGuard(box, 'gh', ['pr', 'merge', '1']);
  assert.equal(denied.code, 64);
  assert.match(denied.stderr, /unclassified command: gh pr merge 1/);
});
