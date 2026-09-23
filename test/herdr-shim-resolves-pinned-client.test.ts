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

interface Fixture {
  root: string;
  bin: string;
  fakeBin: string;
  dataHome: string;
}

async function recorder(filePath: string, label: string): Promise<void> {
  await writeFile(filePath, `#!/usr/bin/env bash\nprintf '%s\\n' "${label}" "$@"\n`, { mode: 0o755 });
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-shim-'));
  scratch.push(root);
  const bin = path.join(root, 'throne-bin');
  const fakeBin = path.join(root, 'fake-bin');
  const dataHome = path.join(root, 'data-home');
  await mkdir(bin, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(bin, 'herdr'), await readFile(path.join(REPO_ROOT, 'bin', 'herdr'), 'utf8'), { mode: 0o755 });
  return { root, bin, fakeBin, dataHome };
}

function runShim(f: Fixture, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(path.join(f.bin, 'herdr'), args, {
      env: { PATH: `${f.bin}:${f.fakeBin}:/usr/bin:/bin`, HOME: f.root, XDG_DATA_HOME: f.dataHome, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function pinned(f: Fixture, tag: string): Promise<string> {
  const dir = path.join(f.dataHome, 'throne', 'herdr', tag);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'herdr');
  await recorder(file, `pinned ${tag}`);
  return file;
}

test('THRONE_HERDR_CLIENT_PATH wins over everything', async () => {
  const f = await fixture();
  await pinned(f, 'v0.8.2');
  await recorder(path.join(f.fakeBin, 'herdr'), 'path herdr');
  const explicit = path.join(f.root, 'explicit-herdr');
  await recorder(explicit, 'explicit');
  const { code, stdout } = await runShim(f, ['tab', 'list'], { THRONE_HERDR_CLIENT_PATH: explicit });
  assert.equal(code, 0);
  assert.deepEqual(stdout.trimEnd().split('\n'), ['explicit', 'tab', 'list']);
});

test('the highest pinned client under the data home is used, not the PATH herdr', async () => {
  const f = await fixture();
  await pinned(f, 'v0.8.2');
  await pinned(f, 'v0.10.0');
  await pinned(f, 'v0.9.1');
  await recorder(path.join(f.fakeBin, 'herdr'), 'path herdr');
  const { code, stdout } = await runShim(f, ['tab', 'focus', 'w1:t1D'], {});
  assert.equal(code, 0);
  assert.deepEqual(stdout.trimEnd().split('\n'), ['pinned v0.10.0', 'tab', 'focus', 'w1:t1D']);
});

test('with no pinned client the real herdr further down PATH is used, never the shim itself', async () => {
  const f = await fixture();
  await recorder(path.join(f.fakeBin, 'herdr'), 'path herdr');
  const { code, stdout } = await runShim(f, ['agent', 'list'], {});
  assert.equal(code, 0);
  assert.deepEqual(stdout.trimEnd().split('\n'), ['path herdr', 'agent', 'list']);
});

test('no pinned client and no herdr on PATH is exit 127 with the searched location named', async () => {
  const f = await fixture();
  const { code, stderr } = await runShim(f, ['tab', 'list'], {});
  assert.equal(code, 127);
  assert.match(stderr, /throne herdr shim/);
  assert.match(stderr, /throne\/herdr/);
});
