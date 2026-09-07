// Requirement: bin/git refuses to create commits under a machine-local git
// identity with a STOP that tells the agent to ask the Lord, signs with the
// config.user.ts identity when `throne-cli git-identity` provides one (no
// global config touched), honours an explicit GIT_AUTHOR_EMAIL, and leaves
// every non-commit subcommand untouched. The real git is a fake that records
// its argv, so nothing here commits anywhere.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

interface Fixture {
  bin: string;
  argvLog: string;
  identityFile: string;
  env: NodeJS.ProcessEnv;
}

/** A throne-shaped bin dir: the real shim copied in, a fake `throne-cli`
 *  answering `git-identity` from a file, and a fake real `git` further down
 *  PATH that records argv and answers `config --get` from env. */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-shim-guard-'));
  scratch.push(root);
  const bin = path.join(root, 'throne-bin');
  const fakeBin = path.join(root, 'fake-bin');
  await mkdir(bin, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(bin, 'git'), await readFile(path.join(REPO_ROOT, 'bin', 'git'), 'utf8'), { mode: 0o755 });
  const identityFile = path.join(root, 'identity.txt');
  const argvLog = path.join(root, 'argv.log');
  await writeFile(
    path.join(bin, 'throne-cli'),
    `#!/usr/bin/env bash\n[ "$1" = git-identity ] || exit 2\nprintf '%s\\n' "$@" > "${identityFile}.args"\n[ -s "${identityFile}" ] || exit 3\ncat "${identityFile}"\n`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(fakeBin, 'git'),
    `#!/usr/bin/env bash\nif [ "$1" = remote ]; then printf '%s\\n' "\${FAKE_ORIGIN:-}"; [ -n "\${FAKE_ORIGIN:-}" ] || exit 2; exit 0; fi\nif [ "$1" = rev-parse ]; then printf '%s\\n' "\${FAKE_TOPLEVEL:-/repo}"; exit 0; fi\nprintf '%s\\n' "$@" > "${argvLog}"\nif [ "$1" = config ] && [ "$2" = --get ]; then\n  case "$3" in user.email) printf '%s\\n' "\${FAKE_EMAIL:-}";; user.name) printf '%s\\n' "\${FAKE_NAME:-}";; esac\n  [ -n "\${FAKE_EMAIL:-}" ] || exit 1\n  exit 0\nfi\nexit 0\n`,
    { mode: 0o755 },
  );
  await chmod(path.join(bin, 'git'), 0o755);
  return {
    bin,
    argvLog,
    identityFile,
    env: { ...process.env, PATH: `${bin}:${fakeBin}:/usr/bin:/bin`, GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_EMAIL: '', THRONE_GIT_IDENTITY_ORIGIN: '', THRONE_GIT_SIGNING_KEY: '', THRONE_GIT_SIGNING_FORMAT: '' },
  };
}

function runShim(f: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = spawn(path.join(f.bin, 'git'), args, { env: { ...f.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

async function recordedArgv(f: Fixture): Promise<string[]> {
  return (await readFile(f.argvLog, 'utf8')).trimEnd().split('\n');
}

test('a machine-local identity is a STOP (exit 66) that tells the agent to ask the Lord', async () => {
  const f = await fixture();
  const { code, stderr } = await runShim(f, ['commit', '-m', 'Add thing'], { FAKE_EMAIL: 'theuser@Mac.lan', FAKE_NAME: 'theuser' });
  assert.equal(code, 66);
  assert.match(stderr, /STOP RIGHT THERE/);
  assert.match(stderr, /Ask the Lord/);
  assert.match(stderr, /identity: \{ name:/);
  assert.match(stderr, /theuser@Mac\.lan/);
});

for (const [label, email, name] of [
  ['no identity at all', '', ''],
  ['bare user without a domain', 'theuser', 'theuser'],
  ['localhost domain', 'me@localhost', 'Me'],
  ['single-label domain', 'me@mac', 'Me'],
  ['.local domain', 'me@Mac.local', 'Me'],
  ['name set but email blank', '', 'Real Name'],
] as const) {
  test(`${label} is refused before the real git runs`, async () => {
    const f = await fixture();
    const { code } = await runShim(f, ['commit', '-m', 'x'], { FAKE_EMAIL: email, FAKE_NAME: name });
    assert.equal(code, 66);
    const argv = await recordedArgv(f);
    assert.ok(!argv.includes('commit'), `real git must not have been asked to commit: ${argv.join(' ')}`);
  });
}

test('a real identity from git config passes through unchanged', async () => {
  const f = await fixture();
  const { code } = await runShim(f, ['commit', '-m', 'Add thing'], { FAKE_EMAIL: 'someone@example.com', FAKE_NAME: 'Some One' });
  assert.equal(code, 0);
  assert.deepEqual(await recordedArgv(f), ['commit', '-m', 'Add thing']);
});

test('an identity from config.user.ts is injected as -c user.name/user.email and no global is touched', async () => {
  const f = await fixture();
  await writeFile(f.identityFile, 'The Lord\tlord@example.com\tKEYID\topenpgp\n');
  const { code } = await runShim(f, ['-C', '/tmp', 'commit', '-m', 'Add thing'], { FAKE_EMAIL: 'theuser@Mac.lan', FAKE_NAME: 'theuser' });
  assert.equal(code, 0);
  assert.deepEqual(await recordedArgv(f), ['-C', '/tmp', '-c', 'user.name=The Lord', '-c', 'user.email=lord@example.com', '-c', 'user.signingkey=KEYID', '-c', 'commit.gpgsign=true', '-c', 'tag.gpgsign=true', '-c', 'gpg.format=openpgp', 'commit', '-m', 'Add thing']);
});

test('a configured identity without a signing key is a STOP naming the signing key', async () => {
  const f = await fixture();
  await writeFile(f.identityFile, 'The Lord\tlord@example.com\n');
  const { code, stderr } = await runShim(f, ['commit', '-m', 'x'], { FAKE_EMAIL: 'theuser@Mac.lan', FAKE_NAME: 'theuser' });
  assert.equal(code, 66);
  assert.match(stderr, /signing is mandatory/);
});

test('merge, cherry-pick, revert, am and rebase are guarded too', async () => {
  for (const sub of ['merge', 'cherry-pick', 'revert', 'am', 'rebase']) {
    const f = await fixture();
    const { code, stderr } = await runShim(f, [sub, 'main'], { FAKE_EMAIL: 'theuser@Mac.lan', FAKE_NAME: 'theuser' });
    assert.equal(code, 66, sub);
    assert.match(stderr, /STOP RIGHT THERE/, sub);
  }
});

test('the tab identity is trusted when the commit targets the tab origin, and re-resolved for another origin', async () => {
  let f = await fixture();
  await writeFile(f.identityFile, 'Work Me\twork@example.com\tKEY2\topenpgp\n');
  let r = await runShim(f, ['commit', '-m', 'x'], { GIT_AUTHOR_EMAIL: 'personal@example.com', THRONE_GIT_SIGNING_KEY: 'KEY1', THRONE_GIT_IDENTITY_ORIGIN: 'git@github.com:me/dotfiles.git', FAKE_ORIGIN: 'git@github.com:me/dotfiles.git', FAKE_TOPLEVEL: '/repo' });
  assert.equal(r.code, 0);
  assert.deepEqual(await recordedArgv(f), ['-c', 'user.signingkey=KEY1', '-c', 'commit.gpgsign=true', '-c', 'tag.gpgsign=true', '-c', 'gpg.format=openpgp', 'commit', '-m', 'x'], 'same origin: env identity kept, signing pinned on the command line');
  f = await fixture();
  await writeFile(f.identityFile, 'Work Me\twork@example.com\tKEY2\topenpgp\n');
  r = await runShim(f, ['commit', '-m', 'x'], { GIT_AUTHOR_EMAIL: 'personal@example.com', THRONE_GIT_SIGNING_KEY: 'KEY1', THRONE_GIT_IDENTITY_ORIGIN: 'git@github.com:me/dotfiles.git', FAKE_ORIGIN: 'git@github.com:ExampleCorp/some-repo.git', FAKE_TOPLEVEL: '/work/some-repo' });
  assert.equal(r.code, 0);
  assert.deepEqual(await recordedArgv(f), ['-c', 'user.name=Work Me', '-c', 'user.email=work@example.com', '-c', 'user.signingkey=KEY2', '-c', 'commit.gpgsign=true', '-c', 'tag.gpgsign=true', '-c', 'gpg.format=openpgp', 'commit', '-m', 'x'], 'other origin: re-resolved identity injected');
  assert.match(await readFile(`${f.identityFile}.args`, 'utf8'), /--repo\n\/work\/some-repo/);
});

test('an explicit GIT_AUTHOR_EMAIL without a signing key no longer stands the guard aside', async () => {
  const f = await fixture();
  const { code, stderr } = await runShim(f, ['commit', '-m', 'x'], { GIT_AUTHOR_EMAIL: 'ci@example.com', FAKE_EMAIL: '', FAKE_NAME: '' });
  assert.equal(code, 66);
  assert.match(stderr, /STOP RIGHT THERE/);
});

test('non-commit subcommands never consult the identity', async () => {
  const f = await fixture();
  const { code } = await runShim(f, ['status', '--short'], { FAKE_EMAIL: '', FAKE_NAME: '' });
  assert.equal(code, 0);
  assert.deepEqual(await recordedArgv(f), ['status', '--short']);
});

test('the message guard still refuses orchestration provenance after the identity passes', async () => {
  const f = await fixture();
  const { code, stderr } = await runShim(f, ['commit', '-m', 'Alpha finished the campaign'], { FAKE_EMAIL: 'someone@example.com', FAKE_NAME: 'Some One' });
  assert.equal(code, 65);
  assert.match(stderr, /orchestration machinery/);
});
