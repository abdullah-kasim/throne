// Requirement: a herdr tab is created with the config.user.ts git identity
// exported as GIT_AUTHOR_*/GIT_COMMITTER_* so commits in it sign natively;
// with no identity configured nothing is exported (the bin/git shim's STOP
// is then the backstop), and <throne>/bin stays first on PATH either way.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHerdrTab, gitIdentityEnvironment } from '../src/herdr/herdr-tab.service.ts';

function capture(identity: { name: string; email: string; signingKey: string; signingFormat: 'openpgp' | 'ssh'; origin?: string } | undefined) {
  const seenCwd: Array<string | undefined> = [];
  const calls: string[][] = [];
  const deps = {
    runHerdr: (async (args: string[]) => {
      calls.push(args);
      return { stdout: JSON.stringify({ tab_id: 't1', root_pane_id: 'p1' }), stderr: '' };
    }) as never,
    readGitIdentity: async (cwd: string | undefined) => { seenCwd.push(cwd); return identity; },
  };
  return { calls, deps, seenCwd };
}

test('a configured identity is exported as git author and committer env on the tab', async () => {
  const { calls, deps, seenCwd } = capture({ name: 'The Lord', email: 'lord@example.com', signingKey: 'KEYID', signingFormat: 'openpgp', origin: 'git@github.com:ExampleCorp/x.git' });
  await createHerdrTab('shadow-x', '/tmp', deps).catch(() => undefined);
  assert.deepEqual(seenCwd, ['/tmp'], 'the identity is resolved for the tab cwd');
  const args = calls[0] ?? [];
  const env = args.filter((_, i) => args[i - 1] === '--env');
  assert.ok(env.includes('GIT_AUTHOR_NAME=The Lord'), env.join(' '));
  assert.ok(env.includes('GIT_AUTHOR_EMAIL=lord@example.com'));
  assert.ok(env.includes('GIT_COMMITTER_NAME=The Lord'));
  assert.ok(env.includes('GIT_COMMITTER_EMAIL=lord@example.com'));
  assert.ok(env.includes('THRONE_GIT_IDENTITY_ORIGIN=git@github.com:ExampleCorp/x.git'));
  assert.ok(env.includes('GIT_CONFIG_COUNT=4') && env.includes('GIT_CONFIG_KEY_0=user.signingkey') && env.includes('GIT_CONFIG_VALUE_0=KEYID'), 'signing is injected as git env config');
  assert.ok(env.includes('GIT_CONFIG_KEY_1=commit.gpgsign') && env.includes('GIT_CONFIG_VALUE_1=true'));
  assert.ok(env.includes('THRONE_GIT_SIGNING_KEY=KEYID'));
  assert.ok(env.some((e) => /^PATH=.*\/bin:/.test(e)), 'throne bin stays first on PATH');
});

test('no configured identity exports no git env at all', async () => {
  const { calls, deps } = capture(undefined);
  await createHerdrTab('shadow-x', undefined, deps).catch(() => undefined);
  const args = calls[0] ?? [];
  assert.ok(!args.some((a) => a.startsWith('GIT_')), args.join(' '));
});

test('gitIdentityEnvironment carries author, committer, signing config and the origin when known', () => {
  const env = gitIdentityEnvironment({ name: 'A', email: 'a@example.com', signingKey: 'K', signingFormat: 'ssh' });
  assert.deepEqual(env.slice(0, 8), [
    '--env', 'GIT_AUTHOR_NAME=A', '--env', 'GIT_AUTHOR_EMAIL=a@example.com',
    '--env', 'GIT_COMMITTER_NAME=A', '--env', 'GIT_COMMITTER_EMAIL=a@example.com',
  ]);
  assert.ok(env.includes('GIT_CONFIG_VALUE_3=ssh'));
  assert.deepEqual(gitIdentityEnvironment({ name: 'A', email: 'a@example.com', signingKey: 'K', signingFormat: 'openpgp', origin: 'o' }).slice(-2), ['--env', 'THRONE_GIT_IDENTITY_ORIGIN=o']);
  assert.deepEqual(gitIdentityEnvironment(undefined), []);
});
