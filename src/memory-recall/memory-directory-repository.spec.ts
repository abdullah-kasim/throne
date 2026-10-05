import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkoutOfMemoryDirectory } from './memory-directory-repository.ts';

async function scratchHome(): Promise<string> {
  const home = path.join(await mkdtemp(path.join(tmpdir(), 'memory-directory-repository-')), 'home');
  await mkdir(home);
  return home;
}

test('a memory directory named relative to home is mapped back to its checkout', async () => {
  const home = await scratchHome();
  const checkout = path.join(home, 'Documents', 'Development', 'bakery-dashboard', '.bare');
  await mkdir(checkout, { recursive: true });
  await mkdir(path.join(home, 'Documents', 'Development', 'bakery'), { recursive: true });
  const memoryDirectory = path.join(home, '.memories', 'Documents-Development-bakery-dashboard-.bare');
  assert.equal(await checkoutOfMemoryDirectory(memoryDirectory, home), await realpath(checkout));
});

test('a memory directory named for a checkout outside home is still mapped back to its checkout', async () => {
  const home = await scratchHome();
  const checkout = await realpath(await mkdtemp(path.join(tmpdir(), 'memory-directory-outside-')));
  const memoryDirectory = path.join(home, '.memories', checkout.replaceAll(path.sep, '-'));
  assert.equal(await checkoutOfMemoryDirectory(memoryDirectory, home), checkout);
});
