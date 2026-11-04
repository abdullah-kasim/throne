import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OVER_THE_LIMIT = '450\t451\tsrc/large.ts\n';
const AT_THE_LIMIT = '-\t-\tlogo.png\n400\t400\tsrc/exact.ts\n';
const UNDER_THE_LIMIT = '10\t5\tsrc/small.ts\n';
const STAT_TEXT = ' src/large.ts | 901 +++++-----\n 1 file changed, 450 insertions(+), 451 deletions(-)';
const PATCH_TEXT = 'PATCH-OUTPUT-FROM-THE-REAL-GIT';
const COUNT_LINE = 'throne git guard: this diff is 901 changed lines (limit 800).';
const HARNESSES = ['claude', 'codex'] as const;

const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

interface Fixture {
  bin: string;
  harnessDirectory: string;
  callLog: string;
  numstatFile: string;
  env: NodeJS.ProcessEnv;
}

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function fixture(numstat: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-shim-diff-cap-'));
  scratch.push(root);
  const bin = path.join(root, 'shim-bin');
  const fakeBin = path.join(root, 'fake-bin');
  const harnessDirectory = path.join(root, 'harness');
  await mkdir(bin, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(harnessDirectory, { recursive: true });
  await writeFile(path.join(bin, 'git'), await readFile(path.join(REPO_ROOT, 'bin', 'git'), 'utf8'), { mode: 0o755 });
  const callLog = path.join(root, 'calls.log');
  const numstatFile = path.join(root, 'numstat.txt');
  await writeFile(numstatFile, numstat);
  await writeFile(
    path.join(fakeBin, 'git'),
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" >> "${callLog}"`,
      'path_named=false',
      'for argument in "${@:2}"; do',
      '  case "$argument" in',
      '    --) break ;;',
      `    -*) [ "$path_named" = false ] || { echo "fatal: option '$argument' must come before non-option arguments" >&2; exit 128; } ;;`,
      '    *:*) ;;',
      '    *.ts) path_named=true ;;',
      '  esac',
      'done',
      'for argument in "$@"; do',
      `  [ "$argument" = --numstat ] && { cat "${numstatFile}"; case " $* " in *" --no-merges "*) ;; *) printf '%s' "\${FAKE_MERGE_NUMSTAT:-}" ;; esac; exit 0; }`,
      `  [ "$argument" = --stat ] && { printf '%s\\n' "${STAT_TEXT}"; exit 0; }`,
      'done',
      'if [ "$1" = cat-file ]; then',
      '  while read -r name; do case "$name" in *:*) echo blob ;; *) echo commit ;; esac; done',
      '  exit 0',
      'fi',
      'if [ "$1" = rev-parse ]; then',
      '  [ "$2" = --revs-only ] || exit 128',
      '  shift 2',
      '  default_revision=',
      '  [ "$1" != --default ] || { default_revision=$2; shift 2; }',
      '  revisions=0',
      '  for name in "$@"; do case "$name" in *:*) echo "$name" ;; *.ts) continue ;; *..*) printf \'%s\\n^%s\\n\' "${name#*..}" "${name%%..*}" ;; *) echo "$name" ;; esac; revisions=$((revisions + 1)); done',
      '  [ "$revisions" -gt 0 ] || [ -z "$default_revision" ] || echo "$default_revision"',
      '  exit 0',
      'fi',
      `echo ${PATCH_TEXT}`,
      'exit "${FAKE_EXIT:-0}"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  for (const harness of HARNESSES) {
    await writeFile(path.join(harnessDirectory, harness), '#!/bin/bash\nbash -c "$1"\n', { mode: 0o755 });
  }
  return {
    bin,
    harnessDirectory,
    callLog,
    numstatFile,
    env: { ...process.env, PATH: `${bin}:${fakeBin}:/usr/bin:/bin`, LC_ALL: 'C', THRONE_AGENT_PANE: '1', THRONE_LIVE_ROOT: '' },
  };
}

function run(executable: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<Outcome>((resolve) => {
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function typedByAgent(f: Fixture, command: string, harness: string = 'claude', extraEnv: NodeJS.ProcessEnv = {}) {
  return run(path.join(f.harnessDirectory, harness), [`${command} && true`], { ...f.env, ...extraEnv });
}

function typedAsLoneCommand(f: Fixture, command: string, harness: string) {
  return run(path.join(f.harnessDirectory, harness), [command], f.env);
}

async function recordedCalls(f: Fixture): Promise<string[]> {
  return (await readFile(f.callLog, 'utf8')).trimEnd().split('\n');
}

function assertRefused(outcome: Outcome) {
  assert.equal(outcome.code, 69, outcome.stderr);
  assert.equal(outcome.stdout, '');
}

for (const harness of HARNESSES) {
  test(`a git diff typed in ${harness} over 800 changed lines is refused with the count line, the stat text and exit 69, and prints no patch`, async () => {
    const f = await fixture(OVER_THE_LIMIT);
    const outcome = await typedByAgent(f, 'git diff main..topic', harness);
    assertRefused(outcome);
    assert.equal(outcome.stderr.split('\n')[0], COUNT_LINE);
    assert.ok(outcome.stderr.includes(STAT_TEXT), outcome.stderr);
    assert.ok(outcome.stderr.includes('git diff main..topic -- <path>'), outcome.stderr);
    assert.ok(outcome.stderr.includes('git --bypass diff main..topic'), outcome.stderr);
    assert.match(outcome.stderr, /add --bypass yourself/);
    assert.deepEqual(await recordedCalls(f), ['diff --numstat main..topic', 'rev-parse --revs-only main..topic', 'diff --stat main..topic']);
  });

  test(`a lone git diff that the shell runs in place under ${harness} is still refused`, async () => {
    const f = await fixture(OVER_THE_LIMIT);
    assertRefused(await typedAsLoneCommand(f, 'git diff main..topic', harness));
  });
}

for (const [label, numstat] of [['exactly 800', AT_THE_LIMIT], ['under 800', UNDER_THE_LIMIT]] as const) {
  test(`a typed git diff of ${label} changed lines runs the real git with the caller's arguments unchanged`, async () => {
    const f = await fixture(numstat);
    const outcome = await typedByAgent(f, 'git diff --color=never main..topic');
    assert.equal(outcome.code, 0);
    assert.equal(outcome.stdout.trim(), PATCH_TEXT);
    assert.deepEqual(await recordedCalls(f), ['diff --numstat --color=never main..topic', 'diff --color=never main..topic']);
  });
}

test('a binary file counts as 0 changed lines', async () => {
  const f = await fixture('-\t-\thuge.bin\n'.repeat(50) + UNDER_THE_LIMIT);
  const outcome = await typedByAgent(f, 'git diff main..topic');
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stdout.trim(), PATCH_TEXT);
});

test('git --bypass diff over the limit prints the full diff', async () => {
  const f = await fixture(OVER_THE_LIMIT);
  const outcome = await typedByAgent(f, 'git --bypass diff main..topic');
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stdout.trim(), PATCH_TEXT);
  assert.deepEqual(await recordedCalls(f), ['diff main..topic']);
});

for (const flag of ['--stat', '--shortstat', '--numstat', '--dirstat', '--dirstat=files', '--name-only', '--name-status', '--summary', '--raw', '--quiet', '--exit-code', '--check', '-s', '--no-patch']) {
  test(`the short-output flag ${flag} passes through without counting`, async () => {
    const f = await fixture(OVER_THE_LIMIT);
    const outcome = await typedByAgent(f, `git diff main..topic ${flag}`);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.deepEqual(await recordedCalls(f), [`diff main..topic ${flag}`]);
  });
}

test('the real exit code is kept when a short-output call passes through', async () => {
  const f = await fixture(OVER_THE_LIMIT);
  const outcome = await typedByAgent(f, 'git diff --quiet; echo "exit=$?"', 'claude', { FAKE_EXIT: '1' });
  assert.match(outcome.stdout, /exit=1/);
});

test('the real exit code is kept when a counted call is under the limit', async () => {
  const f = await fixture(UNDER_THE_LIMIT);
  const outcome = await typedByAgent(f, 'git diff main..topic; echo "exit=$?"', 'claude', { FAKE_EXIT: '1' });
  assert.match(outcome.stdout, /exit=1/);
});

test('git diff --no-index over the limit is counted and refused', async () => {
  const f = await fixture(OVER_THE_LIMIT);
  assertRefused(await typedByAgent(f, 'git diff --no-index old.txt new.txt'));
});

test('a path-limited diff counts only the paths it would print', async () => {
  const f = await fixture(UNDER_THE_LIMIT);
  const outcome = await typedByAgent(f, 'git diff main..topic -- some/path');
  assert.equal(outcome.code, 0);
  assert.deepEqual(await recordedCalls(f), ['diff --numstat main..topic -- some/path', 'diff main..topic -- some/path']);
});

for (const [command, pathAtATime] of [
  ['git diff src/large.ts', 'git diff -- <path>'],
  ['git diff main src/large.ts', 'git diff main -- <path>'],
  ['git diff main topic src/large.ts src/other.ts', 'git diff main topic -- <path>'],
  ['git show 0123abc src/large.ts', 'git show 0123abc -- <path>'],
] as const) {
  test(`a typed ${command} over the limit, with paths named without --, is refused with the stat text and a path-at-a-time command git accepts`, async () => {
    const f = await fixture(OVER_THE_LIMIT);
    const outcome = await typedByAgent(f, command);
    assertRefused(outcome);
    assert.equal(outcome.stderr.split('\n')[0], COUNT_LINE);
    assert.ok(outcome.stderr.includes(STAT_TEXT), outcome.stderr);
    assert.ok(outcome.stderr.includes(`one path per call: ${pathAtATime}\n`), outcome.stderr);
  });
}

test('git show of a path named without -- counts the commit it defaults to', async () => {
  const f = await fixture(OVER_THE_LIMIT);
  assertRefused(await typedByAgent(f, 'git show src/large.ts'));
});

test('a typed git show of a commit over the limit is refused', async () => {
  const f = await fixture(OVER_THE_LIMIT);
  const outcome = await typedByAgent(f, 'git show 0123abc');
  assertRefused(outcome);
  assert.ok(outcome.stderr.includes('git --bypass show 0123abc'), outcome.stderr);
  assert.ok((await recordedCalls(f)).includes('show --numstat --format= --no-merges 0123abc'));
});

test('a typed git show of a commit range over the limit is refused', async () => {
  const f = await fixture(OVER_THE_LIMIT);
  const outcome = await typedByAgent(f, 'git show main~3..main');
  assertRefused(outcome);
  assert.equal(outcome.stderr.split('\n')[0], COUNT_LINE);
  assert.ok(outcome.stderr.includes('git --bypass show main~3..main'), outcome.stderr);
});

test('a typed git show of a commit range under the limit prints it', async () => {
  const f = await fixture(UNDER_THE_LIMIT);
  const outcome = await typedByAgent(f, 'git show main~3..main');
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stdout.trim(), PATCH_TEXT);
  assert.ok((await recordedCalls(f)).includes('show --numstat --format= --no-merges main~3..main'));
});

test('merges inside a git show range count 0, since they print only the combined diff', async () => {
  const f = await fixture(UNDER_THE_LIMIT);
  const outcome = await typedByAgent(f, 'git show main~3..main', 'claude', { FAKE_MERGE_NUMSTAT: OVER_THE_LIMIT });
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stdout.trim(), PATCH_TEXT);
});

test('git show of a blob such as HEAD:path is not counted', async () => {
  const f = await fixture(OVER_THE_LIMIT);
  const outcome = await typedByAgent(f, 'git show HEAD:src/large.ts');
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stdout.trim(), PATCH_TEXT);
  assert.ok(!(await recordedCalls(f)).some((call) => call.includes('--numstat')));
});

test('git show of a merge commit counts 0, since it prints only the combined diff', async () => {
  const f = await fixture('');
  const outcome = await typedByAgent(f, 'git show 0123abc', 'claude', { FAKE_MERGE_NUMSTAT: OVER_THE_LIMIT });
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stdout.trim(), PATCH_TEXT);
});

test('outside a court session a large diff prints in full and runs the real git exactly once', async () => {
  const f = await fixture(OVER_THE_LIMIT);
  const outcome = await typedByAgent(f, 'git diff main..topic', 'claude', { THRONE_AGENT_PANE: '', THRONE_LIVE_ROOT: '' });
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stdout.trim(), PATCH_TEXT);
  assert.deepEqual(await recordedCalls(f), ['diff main..topic']);
});

test('a court session marked only by THRONE_LIVE_ROOT is guarded too', async () => {
  const f = await fixture(OVER_THE_LIMIT);
  assertRefused(await typedByAgent(f, 'git diff main..topic', 'claude', { THRONE_AGENT_PANE: '', THRONE_LIVE_ROOT: '/somewhere' }));
});

for (const [program, command] of [
  ['node', `"${process.execPath}" -e 'process.stdout.write(require("node:child_process").execFileSync("git", ["diff", "main..topic"]))'`],
  ['node through sh -c', `"${process.execPath}" -e 'process.stdout.write(require("node:child_process").execSync("git diff main..topic"))'`],
  ['python', `python3 -c 'import subprocess; subprocess.run(["git", "diff", "main..topic"], check=True)'`],
] as const) {
  test(`a ${program} child process an agent started gets the full diff over the limit and runs the real git exactly once`, async () => {
    const f = await fixture(OVER_THE_LIMIT);
    const outcome = await typedByAgent(f, command);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(outcome.stdout.trim(), PATCH_TEXT);
    assert.deepEqual(await recordedCalls(f), ['diff main..topic']);
  });
}

test('a shell script a program runs keeps the full diff', async () => {
  const f = await fixture(OVER_THE_LIMIT);
  const outcome = await typedByAgent(f, `python3 -c 'import subprocess; subprocess.run(["bash", "-c", "git diff main..topic | cat"], check=True)'`);
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.stdout.trim(), PATCH_TEXT);
});
