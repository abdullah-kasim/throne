import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

interface Sandbox {
  guardBin: string;
  realBin: string;
  argvLog: string;
  path: string;
}

async function sandbox(options: { withRealGhe?: boolean; ghRoutesToGhe?: boolean } = {}): Promise<Sandbox> {
  const root = await mkdtemp(path.join(tmpdir(), 'gh-guard-ghe-'));
  scratch.push(root);
  const guardBin = path.join(root, 'throne-bin');
  const realBin = path.join(root, 'real-bin');
  await mkdir(guardBin, { recursive: true });
  await mkdir(realBin, { recursive: true });
  for (const name of ['gh', 'ghe']) {
    await writeFile(path.join(guardBin, name), await readFile(path.join(REPO_ROOT, 'bin', name), 'utf8'), { mode: 0o755 });
  }
  const argvLog = path.join(root, 'argv.log');
  const recorder = `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nexit 0\n`;
  await writeFile(path.join(realBin, 'gh'), options.ghRoutesToGhe ? `#!/usr/bin/env bash\nexec ghe "$@"\n` : recorder, { mode: 0o755 });
  if (options.withRealGhe !== false) await writeFile(path.join(realBin, 'ghe'), recorder, { mode: 0o755 });
  return { guardBin, realBin, argvLog, path: `${guardBin}:${realBin}:/usr/bin:/bin` };
}

function run(box: Sandbox, command: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(path.join(box.guardBin, command), args, { env: { PATH: box.path, HOME: process.env.HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

async function loggedArgv(box: Sandbox): Promise<string[]> {
  return (await readFile(box.argvLog, 'utf8')).trim().split('\n');
}

test('ghe reaches the real ghe for a read the guard allows', async () => {
  const box = await sandbox();
  const result = await run(box, 'ghe', ['pr', 'view', '1']);
  assert.equal(result.code, 0);
  assert.deepEqual(await loggedArgv(box), ['pr', 'view', '1']);
});

test('ghe is denied the mutations gh is denied, and says ghe in the refusal', async () => {
  const box = await sandbox();
  const result = await run(box, 'ghe', ['pr', 'merge', '1', '--squash']);
  assert.equal(result.code, 64);
  assert.match(result.stderr, /denied GitHub mutation or unclassified command: ghe pr merge 1 --squash/);
  await assert.rejects(() => readFile(box.argvLog, 'utf8'));
});

test('ghe honours an explicit --bypass as its first argument', async () => {
  const box = await sandbox();
  const result = await run(box, 'ghe', ['--bypass', 'pr', 'merge', '1']);
  assert.equal(result.code, 0);
  assert.deepEqual(await loggedArgv(box), ['pr', 'merge', '1']);
});

test('a bypass granted to gh survives a gh shim that routes to ghe', async () => {
  const box = await sandbox({ ghRoutesToGhe: true });
  const result = await run(box, 'gh', ['--bypass', 'pr', 'merge', '1']);
  assert.equal(result.code, 0);
  assert.deepEqual(await loggedArgv(box), ['pr', 'merge', '1']);
  assert.match(result.stderr, /BYPASSED by an outer guard's --bypass: ghe pr merge 1/);
});

test('a gh shim that routes to ghe is still judged when no bypass was granted', async () => {
  const box = await sandbox({ ghRoutesToGhe: true });
  const result = await run(box, 'gh', ['pr', 'merge', '1']);
  assert.equal(result.code, 64);
  await assert.rejects(() => readFile(box.argvLog, 'utf8'));
});

test('ghe without a real ghe anywhere on PATH refuses instead of falling back to gh', async () => {
  const box = await sandbox({ withRealGhe: false });
  const result = await run(box, 'ghe', ['pr', 'view', '1']);
  assert.equal(result.code, 127);
  assert.match(result.stderr, /real ghe binary not found/);
});

test('gh keeps judging its own commands under its own name', async () => {
  const box = await sandbox();
  assert.equal((await run(box, 'gh', ['pr', 'view', '1'])).code, 0);
  const denied = await run(box, 'gh', ['pr', 'merge', '1']);
  assert.equal(denied.code, 64);
  assert.match(denied.stderr, /unclassified command: gh pr merge 1/);
});
