import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratchFolders: string[] = [];
after(async () => {
  for (const folder of scratchFolders) await rm(folder, { recursive: true, force: true });
});

interface ScratchRepository {
  folder: string;
  harnessFolder: string;
  env: NodeJS.ProcessEnv;
}

async function scratchRepository(): Promise<ScratchRepository> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-shim-ceremony-'));
  scratchFolders.push(root);
  const wrapperFolder = path.join(root, 'wrapper-bin');
  const folder = path.join(root, 'repository');
  const harnessFolder = path.join(root, 'harness');
  await mkdir(harnessFolder, { recursive: true });
  await writeFile(path.join(harnessFolder, 'claude'), '#!/bin/bash\nbash -c "$1"\n', { mode: 0o755 });
  await mkdir(wrapperFolder, { recursive: true });
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(wrapperFolder, 'git'), await readFile(path.join(repositoryRoot, 'bin', 'git'), 'utf8'), { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    PATH: `${wrapperFolder}:/usr/bin:/bin`,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    TMPDIR: root,
  };
  const scratch = { folder, harnessFolder, env };
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.name', 'Some One'],
    ['config', 'user.email', 'someone@example.com'],
    ['config', 'commit.gpgsign', 'false'],
  ]) await runRealGit(scratch, args);
  await writeFile(path.join(folder, 'readme.txt'), 'first\n');
  await runRealGit(scratch, ['add', 'readme.txt']);
  await runRealGit(scratch, ['commit', '-q', '-m', 'Start the readme']);
  return scratch;
}

function run(command: string, args: string[], scratch: ScratchRepository, input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { cwd: scratch.folder, env: scratch.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

async function runRealGit(scratch: ScratchRepository, args: string[]): Promise<string> {
  const result = await run('/usr/bin/git', args, scratch);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

function runWrapper(scratch: ScratchRepository, args: string[], input?: string) {
  const typedCommand = ['git', ...args].map((argument) => `'${argument.replaceAll("'", "'\\''")}'`).join(' ');
  return run(path.join(scratch.harnessFolder, 'claude'), [`${typedCommand} && true`], scratch, input);
}

function runFromAProgram(scratch: ScratchRepository, args: string[]) {
  return run(path.join(scratch.env.PATH!.split(':')[0]!, 'git'), args, scratch);
}

async function stageAChange(scratch: ScratchRepository, text: string) {
  await writeFile(path.join(scratch.folder, 'readme.txt'), text);
  await runRealGit(scratch, ['add', 'readme.txt']);
}

async function commitCount(scratch: ScratchRepository): Promise<number> {
  return Number((await runRealGit(scratch, ['rev-list', '--count', '--all'])).trim());
}

async function branchWithOneCommit(scratch: ScratchRepository, branch: string) {
  await runRealGit(scratch, ['checkout', '-q', '-b', branch]);
  await writeFile(path.join(scratch.folder, 'other.txt'), 'other\n');
  await runRealGit(scratch, ['add', 'other.txt']);
  await runRealGit(scratch, ['commit', '-q', '-m', 'Add the other file']);
  await runRealGit(scratch, ['checkout', '-q', 'main']);
  await stageAChange(scratch, 'diverged\n');
  await runRealGit(scratch, ['commit', '-q', '-m', 'Change the readme']);
}

for (const [label, message, word] of [
  ['a commit subject naming an agent', 'Fix parsing for shadow-x', 'shadow-x'],
  ['a commit subject with the lowercase role word shadow', 'Teach the shadow parser', 'shadow'],
  ['a commit subject naming a step', 'Record 99c result', '99c'],
  ['a commit body saying verdict in capitals', 'Fix parsing\n\nThe VERDICT was clear', 'VERDICT'],
  ['a commit subject saying conformance', 'Check Conformance of the parser', 'Conformance'],
  ['a commit body saying grade the', 'Fix parsing\n\nGrade the parser output', 'Grade the'],
  ['a commit subject saying candidate', 'Pick the candidate parser', 'candidate'],
  ['a commit body naming an alpha', 'Fix parsing\n\nasked by alpha-breadline-01', 'alpha-breadline-01'],
] as const) {
  test(`${label} is refused with exit 65 naming the word`, async () => {
    const scratch = await scratchRepository();
    await stageAChange(scratch, 'second\n');
    const result = await runWrapper(scratch, ['commit', '-q', '-m', message]);
    assert.equal(result.code, 65, result.stderr);
    assert.ok(result.stderr.includes(`'${word}'`), result.stderr);
    assert.match(result.stderr, /--bypass on your own judgment/);
    assert.equal(await commitCount(scratch), 1);
  });
}

test('a commit message given with -F naming a shadow is refused', async () => {
  const scratch = await scratchRepository();
  await stageAChange(scratch, 'second\n');
  const messageFile = path.join(scratch.folder, '..', 'message.txt');
  await writeFile(messageFile, 'Fix parsing\n\nWritten by the Shadow\n');
  const result = await runWrapper(scratch, ['commit', '-q', '-F', messageFile]);
  assert.equal(result.code, 65, result.stderr);
  assert.match(result.stderr, /'Shadow'/);
});

test('a commit message read from standard input naming a step is refused', async () => {
  const scratch = await scratchRepository();
  await stageAChange(scratch, 'second\n');
  const result = await runWrapper(scratch, ['commit', '-q', '-F', '-'], 'Fix parsing after 99e\n');
  assert.equal(result.code, 65, result.stderr);
  assert.match(result.stderr, /'99e'/);
});

test('a merge message naming a shadow is refused', async () => {
  const scratch = await scratchRepository();
  await branchWithOneCommit(scratch, 'other-file');
  const result = await runWrapper(scratch, ['merge', '-q', '--no-ff', 'other-file', '-m', 'Deliver shadow-x']);
  assert.equal(result.code, 65, result.stderr);
  assert.match(result.stderr, /'shadow-x'/);
  assert.equal(await commitCount(scratch), 3);
});

test('a merge with no message from a branch named for an agent is refused before git writes it', async () => {
  const scratch = await scratchRepository();
  await branchWithOneCommit(scratch, 'shadow-parser-01');
  const result = await runWrapper(scratch, ['merge', '-q', '--no-edit', 'shadow-parser-01']);
  assert.equal(result.code, 65, result.stderr);
  assert.match(result.stderr, /'shadow-parser-01'/);
  assert.equal(await commitCount(scratch), 3);
});

test('a merge with no message into a branch named for an agent is refused before git writes it', async () => {
  const scratch = await scratchRepository();
  await branchWithOneCommit(scratch, 'other-file');
  await runRealGit(scratch, ['checkout', '-q', '-b', 'alpha-parser-01']);
  const result = await runWrapper(scratch, ['merge', '-q', '--no-edit', 'other-file']);
  assert.equal(result.code, 65, result.stderr);
  assert.match(result.stderr, /'alpha-parser-01'/);
  assert.equal(await commitCount(scratch), 3);
});

test('a fast-forward merge of a branch named for an agent goes through', async () => {
  const scratch = await scratchRepository();
  await runRealGit(scratch, ['checkout', '-q', '-b', 'alpha-parser-01']);
  await stageAChange(scratch, 'second\n');
  await runRealGit(scratch, ['commit', '-q', '-m', 'Change the readme']);
  await runRealGit(scratch, ['checkout', '-q', 'main']);
  const result = await runWrapper(scratch, ['merge', '--ff-only', 'alpha-parser-01']);
  assert.equal(result.code, 0, result.stderr);
});

test('a commit with --bypass goes through and says the word check was bypassed', async () => {
  const scratch = await scratchRepository();
  await stageAChange(scratch, 'second\n');
  const result = await runWrapper(scratch, ['--bypass', 'commit', '-q', '-m', 'Record the 99a verdict']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stderr.trim().split('\n'), ['throne git guard: the ceremony word check was bypassed for this commit message']);
  assert.equal(await commitCount(scratch), 2);
});

test('a merge with --bypass goes through', async () => {
  const scratch = await scratchRepository();
  await branchWithOneCommit(scratch, 'shadow-parser-01');
  const result = await runWrapper(scratch, ['--bypass', 'merge', '-q', '--no-edit', 'shadow-parser-01']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await commitCount(scratch), 4);
});

test('--bypass does not let an AI credit line through', async () => {
  const scratch = await scratchRepository();
  await stageAChange(scratch, 'second\n');
  const result = await runWrapper(scratch, ['--bypass', 'commit', '-q', '-m', 'Fix parsing\n\nCo-Authored-By: Claude <noreply@anthropic.com>']);
  assert.equal(result.code, 67, result.stderr);
  assert.equal(await commitCount(scratch), 1);
});

test('an ordinary readable message goes through', async () => {
  const scratch = await scratchRepository();
  await stageAChange(scratch, 'second\n');
  const result = await runWrapper(scratch, ['commit', '-q', '-m', 'Fix parsing of quoted names\n\nAlphabetical order now holds for shadowed names too.']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(await commitCount(scratch), 2);
});

test('a merge with no message of a branch named for an agent run by a program goes through', async () => {
  const scratch = await scratchRepository();
  await branchWithOneCommit(scratch, 'shadow-parser-01');
  const result = await runFromAProgram(scratch, ['merge', '-q', '--no-edit', 'shadow-parser-01']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await commitCount(scratch), 4);
});
