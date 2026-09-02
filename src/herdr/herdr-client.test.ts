// Requirement: throne's own herdr command execution must not depend on
// PATH resolving to a build whose wire protocol matches the pinned session
// server. `resolveHerdrReadOnlyInvocation` decides, per invocation, which
// executable path a caller gets; these tests pin down its three reachable
// states directly, with no real process spawned and no real filesystem
// touched, so the fallback and the decoupled-flag's untouched contract are
// both proven rather than assumed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveHerdrReadOnlyInvocation,
  THRONE_HERDR_SESSION_NAME,
} from './herdr-client.ts';

const PINNED_PATH = '/home/example/.local/share/throne/herdr/v0.8.0/herdr';

test('decouple OFF + pinned binary present resolves execution to the pinned path, unprefixed', () => {
  const invocation = resolveHerdrReadOnlyInvocation(
    ['agent', 'list'],
    false,
    () => PINNED_PATH,
    (filePath) => filePath === PINNED_PATH,
  );
  assert.equal(invocation.executablePath, PINNED_PATH);
  assert.deepEqual(invocation.args, ['agent', 'list']);
});

test('decouple OFF + pinned binary absent falls back to bare PATH herdr', () => {
  const invocation = resolveHerdrReadOnlyInvocation(
    ['agent', 'list'],
    false,
    () => PINNED_PATH,
    () => false,
  );
  assert.equal(invocation.executablePath, 'herdr');
  assert.deepEqual(invocation.args, ['agent', 'list']);
});

test('decouple ON is unchanged: pinned path with explicit --session targeting, regardless of on-disk existence', () => {
  const invocation = resolveHerdrReadOnlyInvocation(
    ['agent', 'list'],
    true,
    () => PINNED_PATH,
    () => false,
  );
  assert.equal(invocation.executablePath, PINNED_PATH);
  assert.deepEqual(invocation.args, ['--session', THRONE_HERDR_SESSION_NAME, 'agent', 'list']);
});

test('the existence check defaults to the real filesystem when not injected', () => {
  const invocation = resolveHerdrReadOnlyInvocation(['agent', 'list'], false, () => '/nonexistent/path/to/herdr');
  assert.equal(invocation.executablePath, 'herdr');
});
