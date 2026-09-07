// Requirement: against real git, a linked worktree and a nested subdirectory
// resolve to the main checkout's memory directory, so every worktree of one
// project shares one memory; a non-git directory keys on itself. The
// operator tool is hidden by an empty PATH so the throne-native fallback is
// what is under test.
import assert from 'node:assert/strict';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';

import { git, initRepo } from './git-repo-test-fixture.ts';
import { resolveMemoryDir, throneNativeMemoryDir } from '../src/memory-dir/memory-dir-resolver.ts';
import { PRODUCTION_MEMORY_RESOLVER_DEPS } from '../src/memory-dir/memory-dir-runtime.ts';

const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const deps = {
  ...PRODUCTION_MEMORY_RESOLVER_DEPS,
  findExecutable: async () => undefined,
  homeDir: () => '/home/fixture',
};

test('real git: worktree and subdirectory share the main checkout memory; non-git keys on itself', async () => {
  const main = await realpath(await initRepo('throne-memory-dir-'));
  scratch.push(main);
  const worktrees = await mkdtemp(path.join(tmpdir(), 'throne-memory-dir-wt-'));
  scratch.push(worktrees);
  const feature = path.join(worktrees, 'feature');
  await git(main, ['worktree', 'add', '-q', feature, '-b', 'feature']);
  const nested = path.join(main, 'src', 'deep');
  await mkdir(nested, { recursive: true });
  const plain = await mkdtemp(path.join(tmpdir(), 'throne-memory-dir-plain-'));
  scratch.push(plain);

  const expected = throneNativeMemoryDir('/home/fixture', main);
  for (const dir of [main, feature, nested]) {
    const resolution = await resolveMemoryDir(dir, deps);
    assert.equal(resolution.mode, 'throne-native', dir);
    assert.equal(resolution.repoRoot, main, dir);
    assert.equal(resolution.path, expected, dir);
  }

  const plainResolution = await resolveMemoryDir(plain, deps);
  assert.equal(plainResolution.repoRoot, await realpath(plain));
  assert.equal(plainResolution.path, throneNativeMemoryDir('/home/fixture', await realpath(plain)));
});
