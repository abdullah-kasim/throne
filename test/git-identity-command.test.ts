// Requirement: `throne git-identity` prints `<name>\t<email>` for a
// repository from the config.user.ts identity section — the `remotes` rule
// matching the origin (`host:owner` beats `host`, `default` names the
// name/email pair) else the default — exits 3 when nothing applies, 1 when
// the file cannot be loaded, and steers unknown arguments.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GIT_IDENTITY_UNSET_EXIT_CODE,
  parseRemote,
  resolveGitIdentity,
  resolveGitIdentityForRemote,
  runGitIdentity,
  type GitIdentityDependencies,
} from '../src/git-identity/git-identity.command.ts';

const SECTION = {
  name: 'Example Person',
  email: 'personal@example.com',
  signingKey: 'KEY1',
  identities: {
    work: { name: 'Example Person', email: 'work@examplecorp.example', signingKey: 'KEY2' },
    sshy: { name: 'S', email: 's@example.com', signingKey: '~/.ssh/id_ed25519.pub', signingFormat: 'ssh' },
    inherits: { name: 'I', email: 'i@example.com' },
  },
  remotes: {
    'github.com:example-owner': 'default',
    'github.example-corp.com': 'work',
    'github.com:ExampleCorp': 'work',
    'git.example.org': 'sshy',
    'github.com:inheriting': 'inherits',
  },
};

function harness(section: Record<string, unknown> | undefined | Error, origins: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const dependencies: GitIdentityDependencies = {
    readIdentitySection: async () => {
      if (section instanceof Error) throw section;
      return section;
    },
    readOriginUrl: async (repo) => origins[repo],
    cwd: () => '/cwd/repo',
    writeStdout: (text) => out.push(text),
    writeStderr: (text) => err.push(text),
  };
  return { dependencies, out, err };
}

test('parseRemote handles scp, ssh and https forms case-insensitively', () => {
  assert.deepEqual(parseRemote('git@github.com:ExampleCorp/some-repo.git'), { host: 'github.com', owner: 'examplecorp' });
  assert.deepEqual(parseRemote('ssh://git@github.example-corp.com/Org/repo.git'), { host: 'github.example-corp.com', owner: 'org' });
  assert.deepEqual(parseRemote('https://github.com/example-owner/x'), { host: 'github.com', owner: 'example-owner' });
  assert.equal(parseRemote('not a remote'), undefined);
});

test('host:owner rule wins over host, default names the top-level pair, unmatched falls back', () => {
  assert.equal(resolveGitIdentityForRemote(SECTION, 'git@github.com:ExampleCorp/some-repo.git')?.email, 'work@examplecorp.example');
  assert.equal(resolveGitIdentityForRemote(SECTION, 'https://github.example-corp.com/org/thing')?.email, 'work@examplecorp.example');
  assert.equal(resolveGitIdentityForRemote(SECTION, 'git@github.com:example-owner/dotfiles.git')?.email, 'personal@example.com');
  assert.equal(resolveGitIdentityForRemote(SECTION, 'git@github.com:someone-else/x.git')?.email, 'personal@example.com');
  assert.equal(resolveGitIdentityForRemote(SECTION, undefined)?.email, 'personal@example.com');
  assert.equal(resolveGitIdentityForRemote({ remotes: SECTION.remotes, identities: SECTION.identities }, 'git@github.com:someone/x')?.email, undefined);
});

test('signing is mandatory: keys resolve per identity, inherit from the default, and an identity without one is unset', () => {
  assert.equal(resolveGitIdentityForRemote(SECTION, 'git@github.com:ExampleCorp/x')?.signingKey, 'KEY2');
  assert.deepEqual(resolveGitIdentityForRemote(SECTION, 'git@git.example.org:o/r'), { name: 'S', email: 's@example.com', signingKey: '~/.ssh/id_ed25519.pub', signingFormat: 'ssh' });
  assert.equal(resolveGitIdentityForRemote(SECTION, 'git@github.com:inheriting/x')?.signingKey, 'KEY1');
  assert.equal(resolveGitIdentity({ name: 'A', email: 'a@example.com' }), undefined);
  assert.equal(resolveGitIdentity({ name: 'A', email: 'a@example.com', signingKey: 'K', signingFormat: 'pgp' }), undefined);
});

test('an identity that only lacks the signing key is exit 3 naming the signing key', async () => {
  const h = harness({ name: 'A', email: 'a@example.com' });
  assert.equal(await runGitIdentity([], h.dependencies), GIT_IDENTITY_UNSET_EXIT_CODE);
  assert.match(h.err.join(''), /signing key is mandatory/);
});

test('the command reads the cwd origin by default, honours --repo and --remote', async () => {
  let h = harness(SECTION, { '/cwd/repo': 'git@github.com:ExampleCorp/some-repo.git' });
  assert.equal(await runGitIdentity([], h.dependencies), 0);
  assert.deepEqual(h.out, ['Example Person\twork@examplecorp.example\tKEY2\topenpgp\n']);
  h = harness(SECTION, { '/other': 'git@github.com:example-owner/dotfiles.git' });
  assert.equal(await runGitIdentity(['--repo', '/other'], h.dependencies), 0);
  assert.deepEqual(h.out, ['Example Person\tpersonal@example.com\tKEY1\topenpgp\n']);
  h = harness(SECTION);
  assert.equal(await runGitIdentity(['--remote', 'https://github.example-corp.com/x/y'], h.dependencies), 0);
  assert.deepEqual(h.out, ['Example Person\twork@examplecorp.example\tKEY2\topenpgp\n']);
});

for (const [label, section] of [
  ['absent section', undefined],
  ['blank email', { name: 'A', email: '  ', signingKey: 'K' }],
  ['missing name', { email: 'a@example.com', signingKey: 'K' }],
  ['non-string name', { name: 5, email: 'a@example.com', signingKey: 'K' }],
] as const) {
  test(`${label} is exit 3 with nothing on stdout`, async () => {
    const h = harness(section as Record<string, unknown> | undefined);
    assert.equal(await runGitIdentity([], h.dependencies), GIT_IDENTITY_UNSET_EXIT_CODE);
    assert.deepEqual(h.out, []);
    assert.match(h.err.join(''), /identity\.name|signing key/);
  });
}

test('a config that cannot be loaded is exit 1 with the cause', async () => {
  const h = harness(new Error('Invalid config in config.user.ts'));
  assert.equal(await runGitIdentity([], h.dependencies), 1);
  assert.match(h.err.join(''), /Invalid config/);
});

test('an unknown argument is a steered exit 2', async () => {
  const h = harness(SECTION);
  assert.equal(await runGitIdentity(['--json'], h.dependencies), 2);
  assert.match(h.err.join(''), /Usage: \.\/bin\/throne-cli git-identity/);
  assert.match(h.err.join(''), /supervisor/);
  assert.deepEqual(h.out, []);
});

test('resolveGitIdentity trims and requires name, email and signing key', () => {
  assert.deepEqual(resolveGitIdentity({ name: ' A ', email: ' a@example.com ', signingKey: ' K ' }), { name: 'A', email: 'a@example.com', signingKey: 'K', signingFormat: 'openpgp' });
  assert.equal(resolveGitIdentity({ name: 'A', signingKey: 'K' }), undefined);
});
