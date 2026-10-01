import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ATTRIBUTION_REFUSED = 67;
const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  bin: string;
  argvLog: string;
  env: NodeJS.ProcessEnv;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'attribution-fence-'));
  scratch.push(root);
  const bin = path.join(root, 'throne-bin');
  const fakeBin = path.join(root, 'fake-bin');
  await mkdir(bin, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  for (const name of ['git', 'gh', 'ghe']) {
    await writeFile(path.join(bin, name), await readFile(path.join(REPO_ROOT, 'bin', name), 'utf8'), { mode: 0o755 });
  }
  const argvLog = path.join(root, 'argv.log');
  const recorder = `#!/usr/bin/env bash\nif [ "$1" = remote ]; then exit 2; fi\nif [ "$1" = rev-parse ]; then printf '/repo\\n'; exit 0; fi\nprintf '%s\\n' "$@" > "${argvLog}"\nexit 0\n`;
  for (const name of ['git', 'gh', 'ghe']) {
    await writeFile(path.join(fakeBin, name), recorder, { mode: 0o755 });
  }
  return {
    root,
    bin,
    argvLog,
    env: {
      ...process.env,
      PATH: `${bin}:${fakeBin}:/usr/bin:/bin`,
      GIT_AUTHOR_EMAIL: 'author@example.com',
      GIT_COMMITTER_EMAIL: 'author@example.com',
      THRONE_GIT_SIGNING_KEY: 'EXAMPLEKEY',
      THRONE_GIT_IDENTITY_ORIGIN: '',
      THRONE_GH_GUARD_WAIVED: '',
    },
  };
}

function run(
  f: Fixture,
  tool: string,
  args: string[],
  stdin = '',
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(path.join(f.bin, tool), args, { env: { ...f.env, ...extraEnv } });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(stdin);
  });
}

async function realBinaryWasReached(f: Fixture): Promise<boolean> {
  try {
    await stat(f.argvLog);
    return true;
  } catch {
    return false;
  }
}

const CLAUDE_TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

for (const [label, args, stdin] of [
  ['commit -m', ['commit', '-m', 'Add the cart', '-m', CLAUDE_TRAILER], ''],
  ['commit -am', ['commit', '-am', `Add the cart\n\n${CLAUDE_TRAILER}`], ''],
  ['commit with an attached -m', ['commit', `-mAdd the cart\n${CLAUDE_TRAILER}`], ''],
  ['commit --message=', ['commit', `--message=Add the cart\n\n${CLAUDE_TRAILER}`], ''],
  ['commit -F - from stdin', ['commit', '-F', '-'], `Add the cart\n\n${CLAUDE_TRAILER}\n`],
  ['commit --trailer for another model', ['commit', '-m', 'Add the cart', '--trailer', 'Co-authored-by: GPT-5 <bot@openai.com>'], ''],
  ['commit with a generated-with footer', ['commit', '-m', 'Add the cart\n\nGenerated with [Claude Code](https://claude.com/claude-code)'], ''],
  ['tag -m', ['tag', '-a', 'v1', '-m', `v1\n${CLAUDE_TRAILER}`], ''],
  ['merge -m', ['merge', '--no-ff', 'topic', '-m', `Merge topic\n${CLAUDE_TRAILER}`], ''],
] as const) {
  test(`git refuses an AI attribution line in ${label} and never reaches the real git`, async () => {
    const f = await fixture();
    const result = await run(f, 'git', [...args], stdin);
    assert.equal(result.code, ATTRIBUTION_REFUSED, result.stderr);
    assert.match(result.stderr, /carries an AI attribution line/);
    assert.equal(await realBinaryWasReached(f), false);
  });
}

test('git refuses an AI attribution line read from a -F message file', async () => {
  const f = await fixture();
  const messageFile = path.join(f.root, 'message.txt');
  await writeFile(messageFile, `Add the cart\n\n${CLAUDE_TRAILER}\n`);
  const result = await run(f, 'git', ['commit', '-F', messageFile]);
  assert.equal(result.code, ATTRIBUTION_REFUSED, result.stderr);
  assert.equal(await realBinaryWasReached(f), false);
});

test('git lets a clean commit and a human co-author through, and keeps a stdin message readable', async () => {
  const f = await fixture();
  const human = await run(f, 'git', ['commit', '-m', 'Add the cart', '-m', 'Co-authored-by: Jane Doe <jane@example.com>']);
  assert.equal(human.code, 0, human.stderr);
  assert.match(await readFile(f.argvLog, 'utf8'), /Jane Doe/);
  const fromStdin = await run(f, 'git', ['commit', '-F', '-'], 'Add the basket\n');
  assert.equal(fromStdin.code, 0, fromStdin.stderr);
  const argv = (await readFile(f.argvLog, 'utf8')).split('\n');
  const messagePath = argv[argv.indexOf('-F') + 1];
  assert.notEqual(messagePath, '-');
  assert.equal(await readFile(messagePath, 'utf8'), 'Add the basket\n');
});

for (const [label, args, stdin, extraEnv] of [
  ['pr create --body even with --bypass', ['--bypass', 'pr', 'create', '--title', 'Cart', '--body', `Adds the cart.\n\n${CLAUDE_TRAILER}`], '', {}],
  ['pr comment -b with a generated-with footer', ['--bypass', 'pr', 'comment', '1', '-b', 'Fixed. Generated with Claude Code'], '', {}],
  ['pr edit --body-file - from stdin', ['--bypass', 'pr', 'edit', '1', '--body-file', '-'], `Body\n\n${CLAUDE_TRAILER}\n`, {}],
  ['api -f body=', ['--bypass', 'api', 'repos/o/r/issues/1/comments', '-f', `body=Done. ${CLAUDE_TRAILER}`], '', {}],
  ['a comment under an outer waiver', ['pr', 'comment', '1', '-b', CLAUDE_TRAILER], '', { THRONE_GH_GUARD_WAIVED: '1' }],
] as const) {
  test(`gh refuses an AI attribution line in ${label}`, async () => {
    const f = await fixture();
    const result = await run(f, 'gh', [...args], stdin, extraEnv);
    assert.equal(result.code, ATTRIBUTION_REFUSED, result.stderr);
    assert.equal(await realBinaryWasReached(f), false);
  });
}

test('gh refuses an AI attribution line in a --body-file and in an api field read from a file', async () => {
  const f = await fixture();
  const body = path.join(f.root, 'body.md');
  await writeFile(body, `Adds the cart.\n\n${CLAUDE_TRAILER}\n`);
  const edit = await run(f, 'gh', ['--bypass', 'pr', 'edit', '1', '--body-file', body]);
  assert.equal(edit.code, ATTRIBUTION_REFUSED, edit.stderr);
  const api = await run(f, 'gh', ['--bypass', 'api', 'repos/o/r/pulls/1', '-X', 'PATCH', '-F', `body=@${body}`]);
  assert.equal(api.code, ATTRIBUTION_REFUSED, api.stderr);
  assert.equal(await realBinaryWasReached(f), false);
});

test('ghe goes through the same attribution fence', async () => {
  const f = await fixture();
  const result = await run(f, 'ghe', ['--bypass', 'pr', 'comment', '1', '-b', CLAUDE_TRAILER]);
  assert.equal(result.code, ATTRIBUTION_REFUSED, result.stderr);
  assert.equal(await realBinaryWasReached(f), false);
});

test('gh lets clean bodies and reads through', async () => {
  const f = await fixture();
  const comment = await run(f, 'gh', ['--bypass', 'pr', 'comment', '1', '-b', 'Fixed in abc123.']);
  assert.equal(comment.code, 0, comment.stderr);
  const view = await run(f, 'gh', ['pr', 'view', '1']);
  assert.equal(view.code, 0, view.stderr);
  assert.match(await readFile(f.argvLog, 'utf8'), /view/);
});
