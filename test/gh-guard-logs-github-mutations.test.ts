import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createGhGuardSandbox, runGuard, type GhGuardSandbox } from './support/gh-guard-sandbox.support.ts';

const DENIED = 64;
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const LOGGED_KEYS = ['agent', 'exit_code', 'host', 'pr', 'repo', 'subcommand', 'timestamp'];

function githubActionLog(box: GhGuardSandbox): string {
  return path.join(box.dataHome, 'data', 'github-actions.jsonl');
}

async function loggedActions(box: GhGuardSandbox): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(githubActionLog(box), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function assertNothingLogged(box: GhGuardSandbox): Promise<void> {
  await assert.rejects(() => readFile(githubActionLog(box), 'utf8'), { code: 'ENOENT' });
}

for (const guardDirectoryLast of [false, true]) {
  test(`a bypassed pull request edit is logged with its agent, host, repo, subcommand, pull request number and exit code${guardDirectoryLast ? ' (guard directory last on PATH)' : ''}`, async () => {
    const box = await createGhGuardSandbox({ guardDirectoryLast });
    const result = await runGuard(
      box,
      'gh',
      ['--bypass', 'pr', 'edit', '12', '-R', 'git.example.test/acme/widgets', '--add-reviewer', 'octo-reviewer'],
      { THRONE_AGENT_NAME: 'stager-example' },
    );
    assert.equal(result.code, 0, result.stderr);
    const [action, ...rest] = await loggedActions(box);
    assert.deepEqual(rest, []);
    assert.deepEqual(Object.keys(action ?? {}).sort(), LOGGED_KEYS);
    assert.match(String(action?.timestamp), ISO_UTC_TIMESTAMP);
    assert.deepEqual({ ...action, timestamp: undefined }, {
      timestamp: undefined,
      agent: 'stager-example',
      host: 'git.example.test',
      repo: 'acme/widgets',
      subcommand: 'pr edit -R --add-reviewer',
      pr: 12,
      exit_code: 0,
    });
  });
}

test('viewing a pull request is not logged', async () => {
  const box = await createGhGuardSandbox();
  assert.equal((await runGuard(box, 'gh', ['pr', 'view', '12', '-R', 'acme/widgets'])).code, 0);
  assert.equal((await runGuard(box, 'gh', ['--bypass', 'pr', 'view', '12', '-R', 'acme/widgets'])).code, 0);
  await assertNothingLogged(box);
});

test('a GET through gh api is not logged', async () => {
  const box = await createGhGuardSandbox();
  assert.equal((await runGuard(box, 'gh', ['api', 'repos/acme/widgets/pulls/12'])).code, 0);
  assert.equal((await runGuard(box, 'gh', ['--bypass', 'api', '-X', 'get', 'repos/acme/widgets/pulls/12'])).code, 0);
  await assertNothingLogged(box);
});

test('a mutation the guard refuses is not logged', async () => {
  const box = await createGhGuardSandbox();
  assert.equal((await runGuard(box, 'gh', ['pr', 'merge', '12', '-R', 'acme/widgets'])).code, DENIED);
  assert.equal((await runGuard(box, 'gh', ['api', '-X', 'POST', 'repos/acme/widgets/issues/12/comments'])).code, DENIED);
  await assertNothingLogged(box);
});

test('a logged mutation records the real exit code and still exits with it', async () => {
  const box = await createGhGuardSandbox({ realExitCode: 3 });
  const result = await runGuard(box, 'gh', ['--bypass', 'pr', 'merge', '12', '-R', 'acme/widgets', '--squash']);
  assert.equal(result.code, 3);
  assert.equal(result.stdout, 'real-binary-output\n');
  const [action] = await loggedActions(box);
  assert.equal(action?.exit_code, 3);
  assert.equal(action?.subcommand, 'pr merge -R --squash');
});

test('a log that cannot be written leaves the exit code and output unchanged', async () => {
  const box = await createGhGuardSandbox({ realExitCode: 5 });
  const blockingFile = path.join(box.root, 'not-a-directory');
  await writeFile(blockingFile, '');
  const result = await runGuard(box, 'gh', ['--bypass', 'pr', 'close', '12', '-R', 'acme/widgets'], { THRONE_DATA_HOME: blockingFile });
  assert.equal(result.code, 5);
  assert.equal(result.stdout, 'real-binary-output\n');
  assert.match(result.stderr, /the GitHub action log could not be written/);
});

test('the log never carries a body, a token or file contents', async () => {
  const box = await createGhGuardSandbox();
  const body = 'Please look at the private launch plan';
  const token = 'ghp_ExampleTokenValue0123456789abcdef';
  const fileContents = 'contents of the review notes file';
  const notesFile = path.join(box.root, 'review-notes.md');
  await writeFile(notesFile, fileContents);
  const runs = [
    ['--bypass', 'pr', 'comment', 'https://git.example.test/acme/widgets/pull/5', '--body', `${body} ${token}`],
    ['--bypass', 'pr', 'edit', '5', '-R', 'acme/widgets', '--title', token, '--body-file', notesFile],
    ['--bypass', 'api', '-X', 'POST', 'repos/acme/widgets/issues/5/comments', '-f', `body=${body}`, '-F', `notes=@${notesFile}`, '-H', `Authorization: token ${token}`],
    ['--bypass', 'pr', 'review', '5', '-R', 'acme/widgets', '--approve', '--body-file', '-'],
  ];
  for (const args of runs) {
    assert.equal((await runGuard(box, 'gh', args, { GH_TOKEN: token }, `${body}\n`)).code, 0);
  }
  const log = await readFile(githubActionLog(box), 'utf8');
  for (const secret of [body, token, fileContents, notesFile, 'Authorization']) {
    assert.ok(!log.includes(secret), `the log carried ${JSON.stringify(secret)}:\n${log}`);
  }
  assert.deepEqual((await loggedActions(box)).map((action) => [action.subcommand, action.repo, action.pr]), [
    ['pr comment --body', 'acme/widgets', 5],
    ['pr edit -R --title --body-file', 'acme/widgets', 5],
    ['api -X -f -F -H', 'acme/widgets', 5],
    ['pr review -R --approve --body-file', 'acme/widgets', 5],
  ]);
});

test('a body beginning with dashes never reaches the log', async () => {
  const box = await createGhGuardSandbox();
  const secret = 'release notes: secret';
  const runs = [
    ['--bypass', 'pr', 'comment', '12', '-R', 'acme/widgets', '--body', `--- ${secret}`],
    ['--bypass', 'pr', 'comment', '12', '-R', 'acme/widgets', '-b', `-${secret}`],
    ['--bypass', 'pr', 'edit', '12', '-R', 'acme/widgets', '--title', '--flag-shaped-title'],
    ['--bypass', 'pr', 'edit', '12', '-R', 'acme/widgets', `--body=--- ${secret}`],
  ];
  for (const args of runs) {
    assert.equal((await runGuard(box, 'gh', args)).code, 0);
  }
  const log = await readFile(githubActionLog(box), 'utf8');
  for (const leaked of [secret, '---', 'flag-shaped-title']) {
    assert.ok(!log.includes(leaked), `the log carried ${JSON.stringify(leaked)}:\n${log}`);
  }
  assert.deepEqual((await loggedActions(box)).map((action) => action.subcommand), [
    'pr comment -R --body',
    'pr comment -R -b',
    'pr edit -R --title',
    'pr edit -R --body',
  ]);
});

test('a mutation through ghe re-entering the guard is logged exactly once', async () => {
  const routed = await createGhGuardSandbox({ ghRoutesToGhe: true });
  const throughRouter = await runGuard(routed, 'gh', ['--bypass', 'pr', 'merge', '7', '-R', 'acme/widgets']);
  assert.equal(throughRouter.code, 0, throughRouter.stderr);
  assert.deepEqual((await loggedActions(routed)).map((action) => action.subcommand), ['pr merge -R']);

  const direct = await createGhGuardSandbox();
  assert.equal((await runGuard(direct, 'ghe', ['--bypass', 'pr', 'merge', '7', '-R', 'acme/widgets'])).code, 0);
  assert.deepEqual((await loggedActions(direct)).map((action) => action.subcommand), ['pr merge -R']);
});

test('a mutation through ghe logs the enterprise host its wrapper targets', async () => {
  const box = await createGhGuardSandbox({ realGhePinnedHost: 'enterprise.example.test' });
  const result = await runGuard(box, 'ghe', ['--bypass', 'pr', 'edit', '213', '--add-reviewer', 'someone', '-R', 'acme/widgets']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await loggedActions(box)).map((action) => [action.host, action.repo, action.pr]), [
    ['enterprise.example.test', 'acme/widgets', 213],
  ]);
});

test('a gh mutation naming only owner and repo logs github.com', async () => {
  const box = await createGhGuardSandbox();
  const result = await runGuard(box, 'gh', ['--bypass', 'pr', 'edit', '5645', '--add-reviewer', 'someone', '-R', 'acme/widgets']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await loggedActions(box)).map((action) => [action.host, action.repo, action.pr]), [
    ['github.com', 'acme/widgets', 5645],
  ]);
});

test("a gh mutation naming only owner and repo from an enterprise checkout logs the checkout's host", async () => {
  const box = await createGhGuardSandbox({ originUrl: 'https://enterprise.example.test/acme/checkout.git' });
  const merge = await runGuard(box, 'gh', ['--bypass', 'pr', 'merge', '213', '-R', 'acme/widgets', '--squash']);
  assert.equal(merge.code, 0, merge.stderr);
  const reviewRequest = await runGuard(box, 'gh', ['--bypass', 'api', '-X', 'POST', 'repos/acme/widgets/pulls/213/requested_reviewers']);
  assert.equal(reviewRequest.code, 0, reviewRequest.stderr);
  assert.deepEqual((await loggedActions(box)).map((action) => [action.host, action.repo, action.pr]), [
    ['enterprise.example.test', 'acme/widgets', 213],
    ['enterprise.example.test', 'acme/widgets', 213],
  ]);
});
