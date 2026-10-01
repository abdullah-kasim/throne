import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { isInsideTheLiveCheckoutBuild } from './jev-limiter-build.ts';

const BACKEND_IN_A_BUILD = path.join('dist', 'src', 'relevance-classifier', 'jev-backend.js');
const scratch = await mkdtemp(path.join(tmpdir(), 'jev-limiter-build-'));

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function checkout(name: string, gitEntry: 'directory' | 'file'): Promise<string> {
  const root = path.join(scratch, name);
  await mkdir(root, { recursive: true });
  if (gitEntry === 'directory') await mkdir(path.join(root, '.git'));
  else await writeFile(path.join(root, '.git'), `gitdir: ${path.join(scratch, 'main', '.git', 'worktrees', name)}\n`);
  return root;
}

test('only a backend inside the dist of a main checkout counts as the live build', async () => {
  const main = await checkout('main', 'directory');
  const worktree = await checkout('worktree', 'file');
  assert.equal(await isInsideTheLiveCheckoutBuild(path.join(main, BACKEND_IN_A_BUILD)), true);
  assert.equal(await isInsideTheLiveCheckoutBuild(path.join(worktree, BACKEND_IN_A_BUILD)), false);
  assert.equal(await isInsideTheLiveCheckoutBuild(path.join(main, 'src', 'relevance-classifier', 'jev-backend.ts')), false);
  assert.equal(await isInsideTheLiveCheckoutBuild(path.join(scratch, 'no-checkout', BACKEND_IN_A_BUILD)), false);
});
