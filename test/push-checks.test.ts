import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DISPATCHER_DIRECTORY = path.join(REPO_ROOT, 'git-hooks');
const SYSTEM_PATH = '/usr/bin:/bin';
const REFUSED_SKIP_EXIT_CODE = 68;
const HOOKS_WITH_A_FORWARDER = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-receive', 'update', 'post-receive',
  'post-update', 'reference-transaction', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman',
  'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit', 'post-index-change',
];
const HOOKS_WHOSE_PRESENCE_CHANGES_GIT = ['push-to-checkout', 'proc-receive'];

const scratch: string[] = [];
after(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  work: string;
  remote: string;
  remoteUrl: string;
  checkLog: string;
  guardDirectory: string;
  environment: NodeJS.ProcessEnv;
}

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? -1 : 0), stdout, stderr }));
  });
}

async function writeExecutable(file: string, body: string): Promise<void> {
  await writeFile(file, body, { mode: 0o755 });
}

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(path.join(tmpdir(), 'push-checks-'));
  scratch.push(root);
  const guardDirectory = path.join(root, 'guard-bin');
  await mkdir(guardDirectory);
  await writeExecutable(path.join(guardDirectory, 'git'), await readFile(path.join(REPO_ROOT, 'bin', 'git'), 'utf8'));
  const fakeSsh = path.join(root, 'fake-ssh');
  await writeExecutable(fakeSsh, '#!/bin/sh\nwhile [ $# -gt 1 ]; do shift; done\nexec sh -c "$1"\n');
  const globalConfig = path.join(root, 'gitconfig');
  await writeFile(
    globalConfig,
    `[core]\n\thooksPath = ${DISPATCHER_DIRECTORY}\n[user]\n\tname = Push Test\n\temail = push-test@example.com\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n`,
  );
  const environment: NodeJS.ProcessEnv = {
    PATH: SYSTEM_PATH,
    HOME: root,
    TMPDIR: tmpdir(),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_SSH_COMMAND: fakeSsh,
    GIT_SSH_VARIANT: 'simple',
  };
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  await mkdir(work);
  await gitOrThrow(root, environment, ['init', '--quiet', '--bare', remote]);
  await gitOrThrow(work, environment, ['init', '--quiet']);
  await writeFile(path.join(work, 'file.txt'), 'one\n');
  await gitOrThrow(work, environment, ['add', 'file.txt']);
  await gitOrThrow(work, environment, ['commit', '--quiet', '-m', 'one']);
  const remoteUrl = `push-test-host:${remote}`;
  await gitOrThrow(work, environment, ['remote', 'add', 'origin', remoteUrl]);
  return { root, work, remote, remoteUrl, checkLog: path.join(root, 'checks.log'), guardDirectory, environment };
}

async function gitOrThrow(cwd: string, environment: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  const outcome = await run('git', args, cwd, environment);
  if (outcome.code !== 0) throw new Error(`git ${args.join(' ')} failed (${outcome.code}): ${outcome.stderr}`);
  return outcome.stdout.trim();
}

function plainGit(box: Sandbox, args: string[], cwd = box.work, extra: NodeJS.ProcessEnv = {}): Promise<Outcome> {
  return run('git', args, cwd, { ...box.environment, ...extra });
}

function guardedGit(box: Sandbox, args: string[], cwd = box.work, extra: NodeJS.ProcessEnv = {}): Promise<Outcome> {
  return run(path.join(box.guardDirectory, 'git'), args, cwd, {
    ...box.environment,
    PATH: `${box.guardDirectory}:${SYSTEM_PATH}`,
    ...extra,
  });
}

async function addCheck(box: Sandbox, name: string, exitCode: number, scope: string[] = []): Promise<void> {
  const script = path.join(box.root, `check-${name}`);
  await writeExecutable(
    script,
    `#!/bin/sh\nprintf '%s %s %s\\n' ${name} "$1" "$2" >> "${box.checkLog}"\nsed 's/^/${name} ref /' >> "${box.checkLog}"\necho "check ${name} output"\nexit ${exitCode}\n`,
  );
  await gitOrThrow(box.work, box.environment, ['config', ...scope, '--add', 'push-check.command', `env CHECK_NAME=${name} ${script}`]);
}

async function checkLogLines(box: Sandbox): Promise<string[]> {
  try {
    return (await readFile(box.checkLog, 'utf8')).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function remoteHas(box: Sandbox, ref: string): Promise<boolean> {
  const outcome = await run('git', ['--git-dir', box.remote, 'rev-parse', '--verify', '--quiet', ref], box.root, box.environment);
  return outcome.code === 0;
}

async function addRepositoryHook(box: Sandbox, name: string, log: string): Promise<void> {
  const hooksDirectory = path.join(box.work, '.git', 'hooks');
  await mkdir(hooksDirectory, { recursive: true });
  await writeExecutable(
    path.join(hooksDirectory, name),
    `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "${log}"\n[ "${name}" = pre-push ] && sed 's/^/own ref /' >> "${log}"\nexit 0\n`,
  );
}

test('a failing push check stops the push and prints its output', async () => {
  const box = await sandbox();
  await addCheck(box, 'refuses', 3);

  const outcome = await plainGit(box, ['push', 'origin', 'main']);

  assert.notEqual(outcome.code, 0);
  assert.match(outcome.stderr, /check refuses output/);
  assert.match(outcome.stderr, /push checks: FAILED \(exit 3\)/);
  assert.equal(await remoteHas(box, 'refs/heads/main'), false);
});

test('every push check runs in order with the remote name, url and ref lines, and the first failure wins', async () => {
  const box = await sandbox();
  await addCheck(box, 'first', 0);
  await addCheck(box, 'second', 5);
  await addCheck(box, 'third', 0);
  const head = await gitOrThrow(box.work, box.environment, ['rev-parse', 'HEAD']);

  const outcome = await plainGit(box, ['push', 'origin', 'main']);

  assert.notEqual(outcome.code, 0);
  assert.match(outcome.stderr, /FAILED \(exit 5\).*check-second/);
  assert.deepEqual(await checkLogLines(box), [
    `first origin ${box.remoteUrl}`,
    `first ref refs/heads/main ${head} refs/heads/main ${'0'.repeat(head.length)}`,
    `second origin ${box.remoteUrl}`,
    `second ref refs/heads/main ${head} refs/heads/main ${'0'.repeat(head.length)}`,
  ]);
  assert.equal(await remoteHas(box, 'refs/heads/main'), false);
});

test('a push with no push check configured is left untouched', async () => {
  const box = await sandbox();

  const outcome = await plainGit(box, ['push', 'origin', 'main']);

  assert.equal(outcome.code, 0, outcome.stderr);
  assert.doesNotMatch(outcome.stderr, /push checks/);
  assert.equal(await remoteHas(box, 'refs/heads/main'), true);
});

test('--no-verify and PUSH_CHECK_SKIP=1 skip the push checks for a person at their own terminal', async () => {
  const box = await sandbox();
  await addCheck(box, 'refuses', 3);

  const noVerify = await guardedGit(box, ['push', '--no-verify', 'origin', 'main']);
  assert.equal(noVerify.code, 0, noVerify.stderr);
  assert.equal(await remoteHas(box, 'refs/heads/main'), true);

  await gitOrThrow(box.work, box.environment, ['commit', '--quiet', '--allow-empty', '-m', 'two']);
  const skipVariable = await guardedGit(box, ['push', 'origin', 'main'], box.work, { PUSH_CHECK_SKIP: '1' });
  assert.equal(skipVariable.code, 0, skipVariable.stderr);
  assert.match(skipVariable.stderr, /skipped because PUSH_CHECK_SKIP=1/);
  assert.deepEqual(await checkLogLines(box), []);
});

test('the git guard refuses a court session that skips the push checks without --bypass', async () => {
  const box = await sandbox();
  await addCheck(box, 'refuses', 3);
  const courtSessions: NodeJS.ProcessEnv[] = [{ THRONE_AGENT_PANE: '1' }, { THRONE_LIVE_ROOT: REPO_ROOT }];

  for (const session of courtSessions) {
    for (const skip of [
      { args: ['push', '--no-verify', 'origin', 'main'], extra: {} },
      { args: ['push', 'origin', 'main', '--no-veri'], extra: {} },
      { args: ['push', 'origin', 'main'], extra: { PUSH_CHECK_SKIP: '1' } },
    ]) {
      const outcome = await guardedGit(box, skip.args, box.work, { ...session, ...skip.extra });
      assert.equal(outcome.code, REFUSED_SKIP_EXIT_CODE, `${skip.args.join(' ')}: ${outcome.stderr}`);
      assert.match(outcome.stderr, /a court session may not skip the push checks/);
      assert.match(outcome.stderr, /git --bypass push/);
    }
  }
  assert.equal(await remoteHas(box, 'refs/heads/main'), false);

  const cancelled = await guardedGit(box, ['push', '--no-verify', '--verify', 'origin', 'main'], box.work, { THRONE_AGENT_PANE: '1' });
  assert.notEqual(cancelled.code, REFUSED_SKIP_EXIT_CODE);
  assert.match(cancelled.stderr, /check refuses output/);
});

test('the git guard lets a court session skip the push checks when --bypass comes first', async () => {
  const box = await sandbox();
  await addCheck(box, 'refuses', 3);

  const noVerify = await guardedGit(box, ['--bypass', 'push', '--no-verify', 'origin', 'main'], box.work, { THRONE_AGENT_PANE: '1' });
  assert.equal(noVerify.code, 0, noVerify.stderr);
  assert.match(noVerify.stderr, /BYPASSED by explicit --bypass/);
  assert.equal(await remoteHas(box, 'refs/heads/main'), true);

  await gitOrThrow(box.work, box.environment, ['commit', '--quiet', '--allow-empty', '-m', 'two']);
  const skipVariable = await guardedGit(box, ['--bypass', 'push', 'origin', 'main'], box.work, { THRONE_AGENT_PANE: '1', PUSH_CHECK_SKIP: '1' });
  assert.equal(skipVariable.code, 0, skipVariable.stderr);
  assert.deepEqual(await checkLogLines(box), []);
});

test('a court session may skip the push checks for a local-path remote, which the checks skip anyway', async () => {
  const box = await sandbox();
  await addCheck(box, 'refuses', 3);

  const outcome = await guardedGit(box, ['push', '--no-verify', box.remote, 'HEAD:refs/heads/backup', '-f'], box.work, { THRONE_AGENT_PANE: '1' });

  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(await remoteHas(box, 'refs/heads/backup'), true);
});

test("the repository's own pre-push hook still runs after the checks, from the main checkout and a linked worktree", async () => {
  const box = await sandbox();
  const hookLog = path.join(box.root, 'own-hook.log');
  await addCheck(box, 'passes', 0);
  await addRepositoryHook(box, 'pre-push', hookLog);
  const head = await gitOrThrow(box.work, box.environment, ['rev-parse', 'HEAD']);

  const fromMain = await plainGit(box, ['push', 'origin', 'main']);
  assert.equal(fromMain.code, 0, fromMain.stderr);

  const linked = path.join(box.root, 'linked');
  await gitOrThrow(box.work, box.environment, ['worktree', 'add', '--quiet', '-b', 'side', linked]);
  const fromLinked = await plainGit(box, ['push', 'origin', 'side'], linked);
  assert.equal(fromLinked.code, 0, fromLinked.stderr);

  const zeros = '0'.repeat(head.length);
  assert.deepEqual((await readFile(hookLog, 'utf8')).trim().split('\n'), [
    `pre-push origin ${box.remoteUrl}`,
    `own ref refs/heads/main ${head} refs/heads/main ${zeros}`,
    `pre-push origin ${box.remoteUrl}`,
    `own ref refs/heads/side ${head} refs/heads/side ${zeros}`,
  ]);
  assert.equal((await checkLogLines(box)).filter((line) => line.startsWith('passes origin')).length, 2);
});

test('branch deletions, tag-only pushes and local-path remotes skip the push checks', async () => {
  const box = await sandbox();
  assert.equal((await plainGit(box, ['push', 'origin', 'main', 'main:refs/heads/doomed'])).code, 0);
  await addCheck(box, 'refuses', 3);
  await gitOrThrow(box.work, box.environment, ['tag', 'v1']);

  const deletion = await plainGit(box, ['push', 'origin', '--delete', 'doomed']);
  assert.equal(deletion.code, 0, deletion.stderr);
  assert.equal(await remoteHas(box, 'refs/heads/doomed'), false);

  const tagOnly = await plainGit(box, ['push', 'origin', 'v1']);
  assert.equal(tagOnly.code, 0, tagOnly.stderr);
  assert.equal(await remoteHas(box, 'refs/tags/v1'), true);

  await gitOrThrow(box.work, box.environment, ['commit', '--quiet', '--allow-empty', '-m', 'two']);
  for (const localUrl of [box.remote, `file://${box.remote}`, path.relative(box.work, box.remote)]) {
    const local = await plainGit(box, ['push', localUrl, 'HEAD:refs/heads/local-copy', '-f']);
    assert.equal(local.code, 0, `${localUrl}: ${local.stderr}`);
  }
  assert.deepEqual(await checkLogLines(box), []);
});

test('a repository whose own core.hooksPath hides the dispatcher still gets its push checks through the git guard', async () => {
  const box = await sandbox();
  await gitOrThrow(box.work, box.environment, ['config', 'core.hooksPath', '.husky/_']);
  await addCheck(box, 'refuses', 3);

  const unguarded = await plainGit(box, ['push', '--dry-run', 'origin', 'main']);
  assert.equal(unguarded.code, 0, unguarded.stderr);
  assert.deepEqual(await checkLogLines(box), []);

  const refused = await guardedGit(box, ['push', 'origin', 'main']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /hides the global push checks/);
  assert.match(refused.stderr, /check refuses output/);
  assert.equal(await remoteHas(box, 'refs/heads/main'), false);

  await gitOrThrow(box.work, box.environment, ['config', '--unset-all', 'push-check.command']);
  await addCheck(box, 'passes', 0);
  const head = await gitOrThrow(box.work, box.environment, ['rev-parse', 'HEAD']);
  const allowed = await guardedGit(box, ['push', 'origin', 'main']);
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(await remoteHas(box, 'refs/heads/main'), true);
  const passesLines = (await checkLogLines(box)).filter((line) => line.startsWith('passes'));
  assert.deepEqual(passesLines, [
    `passes origin ${box.remoteUrl}`,
    `passes ref refs/heads/main ${head} refs/heads/main ${'0'.repeat(head.length)}`,
  ]);
});

test('push-check.enabled false switches the checks off globally or per repository, and the own hook still runs', async () => {
  const box = await sandbox();
  const hookLog = path.join(box.root, 'own-hook.log');
  await addCheck(box, 'refuses', 3);
  await addRepositoryHook(box, 'pre-push', hookLog);

  await gitOrThrow(box.work, box.environment, ['config', '--global', 'push-check.enabled', 'false']);
  const offGlobally = await plainGit(box, ['push', 'origin', 'main']);
  assert.equal(offGlobally.code, 0, offGlobally.stderr);
  assert.match(offGlobally.stderr, /push checks: off \(push-check.enabled is false\)/);

  await gitOrThrow(box.work, box.environment, ['config', '--global', '--unset', 'push-check.enabled']);
  await gitOrThrow(box.work, box.environment, ['commit', '--quiet', '--allow-empty', '-m', 'two']);
  assert.notEqual((await plainGit(box, ['push', 'origin', 'main'])).code, 0);

  await gitOrThrow(box.work, box.environment, ['config', 'push-check.enabled', 'false']);
  const offHere = await guardedGit(box, ['push', 'origin', 'main'], box.work, { THRONE_AGENT_PANE: '1' });
  assert.equal(offHere.code, 0, offHere.stderr);

  await gitOrThrow(box.work, box.environment, ['config', 'core.hooksPath', '.husky/_']);
  await gitOrThrow(box.work, box.environment, ['commit', '--quiet', '--allow-empty', '-m', 'three']);
  const offBehindHiddenHooks = await guardedGit(box, ['push', 'origin', 'main']);
  assert.equal(offBehindHiddenHooks.code, 0, offBehindHiddenHooks.stderr);
  assert.match(offBehindHiddenHooks.stderr, /push checks: off/);

  assert.equal((await checkLogLines(box)).filter((line) => line.startsWith('refuses origin')).length, 1);
  assert.equal((await readFile(hookLog, 'utf8')).split('\n').filter((line) => line.startsWith('pre-push origin')).length, 2);
});

test("every other hook git runs forwards to the repository's own hook, from a linked worktree too", async () => {
  for (const name of HOOKS_WITH_A_FORWARDER) {
    await access(path.join(DISPATCHER_DIRECTORY, name), constants.X_OK);
  }
  for (const name of HOOKS_WHOSE_PRESENCE_CHANGES_GIT) {
    await assert.rejects(access(path.join(DISPATCHER_DIRECTORY, name)));
  }

  const box = await sandbox();
  const fresh = await plainGit(box, ['init', '--quiet', path.join(box.root, 'fresh')], box.root);
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.equal(fresh.stderr, '');
  const hookLog = path.join(box.root, 'own-hook.log');
  for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout']) await addRepositoryHook(box, name, hookLog);
  const linked = path.join(box.root, 'linked');
  await gitOrThrow(box.work, box.environment, ['worktree', 'add', '--quiet', '-b', 'side', linked]);
  await gitOrThrow(linked, box.environment, ['commit', '--quiet', '--allow-empty', '-m', 'from the linked checkout']);

  const hooksThatRan = (await readFile(hookLog, 'utf8')).trim().split('\n').map((line) => line.split(' ')[0]);
  assert.deepEqual(hooksThatRan, ['post-checkout', 'pre-commit', 'commit-msg', 'post-commit']);
});

test('copies of the git guard anywhere on PATH reach the real git without looping, and the checks run once', async () => {
  const box = await sandbox();
  const secondGuardDirectory = path.join(box.root, 'second-guard-bin');
  await mkdir(secondGuardDirectory);
  await writeExecutable(path.join(secondGuardDirectory, 'git'), await readFile(path.join(REPO_ROOT, 'bin', 'git'), 'utf8'));
  const stacked = { PATH: `${box.guardDirectory}:${secondGuardDirectory}:${SYSTEM_PATH}` };
  const repeated = { PATH: `${box.guardDirectory}:${secondGuardDirectory}:${box.guardDirectory}:${SYSTEM_PATH}` };
  const realGitFirst = { PATH: `${SYSTEM_PATH}:${secondGuardDirectory}:${box.guardDirectory}` };

  for (const order of [stacked, repeated, realGitFirst]) {
    const version = await guardedGit(box, ['--version'], box.work, order);
    assert.equal(version.code, 0, version.stderr);
    assert.match(version.stdout, /^git version /);
  }

  await gitOrThrow(box.work, box.environment, ['config', 'core.hooksPath', '.husky/_']);
  await addCheck(box, 'passes', 0);
  const hidden = await guardedGit(box, ['push', 'origin', 'main'], box.work, stacked);
  assert.equal(hidden.code, 0, hidden.stderr);
  assert.equal((await checkLogLines(box)).filter((line) => line.startsWith('passes origin')).length, 1);

  await gitOrThrow(box.work, box.environment, ['commit', '--quiet', '--allow-empty', '-m', 'two']);
  const bypassed = await guardedGit(box, ['--bypass', 'push', '--no-verify', 'origin', 'main'], box.work, { ...stacked, THRONE_AGENT_PANE: '1' });
  assert.equal(bypassed.code, 0, bypassed.stderr);
});

test('copies of the gh guard anywhere on PATH reach the real gh without looping', async () => {
  const box = await sandbox();
  const firstGuard = path.join(box.root, 'gh-guard-one');
  const secondGuard = path.join(box.root, 'gh-guard-two');
  const realGhDirectory = path.join(box.root, 'real-gh');
  const argumentLog = path.join(box.root, 'gh-arguments.log');
  for (const directory of [firstGuard, secondGuard, realGhDirectory]) await mkdir(directory);
  for (const directory of [firstGuard, secondGuard]) {
    await writeExecutable(path.join(directory, 'gh'), await readFile(path.join(REPO_ROOT, 'bin', 'gh'), 'utf8'));
  }
  await writeExecutable(path.join(realGhDirectory, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argumentLog}"\n`);

  for (const order of [
    [firstGuard, secondGuard, realGhDirectory],
    [firstGuard, secondGuard, firstGuard, realGhDirectory],
    [realGhDirectory, secondGuard, firstGuard],
  ]) {
    await rm(argumentLog, { force: true });
    const outcome = await run(path.join(firstGuard, 'gh'), ['pr', 'view', '7'], box.root, {
      PATH: `${order.join(':')}:${SYSTEM_PATH}`,
      HOME: box.root,
    });

    assert.equal(outcome.code, 0, outcome.stderr);
    assert.deepEqual((await readFile(argumentLog, 'utf8')).trim().split('\n'), ['pr', 'view', '7']);
  }
});
