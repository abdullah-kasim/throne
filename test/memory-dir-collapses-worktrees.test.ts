// Requirement: against real git, a linked worktree and a nested subdirectory
// resolve to the main checkout's memory directory, so every worktree of one
// project shares one memory; a non-git directory keys on itself. The
// operator tool is hidden by an empty PATH so the throne-native fallback is
// what is under test.
import assert from 'node:assert/strict';
import { mkdir, realpath, rm, symlink } from 'node:fs/promises';
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

function depsWithHome(homeDirectory: string) {
  return {
    ...PRODUCTION_MEMORY_RESOLVER_DEPS,
    findExecutable: async () => undefined,
    homeDir: () => homeDirectory,
  };
}

async function scratchDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  scratch.push(directory);
  return directory;
}

async function homeWithRepository(repositoryUnderHome: string): Promise<{ home: string; repository: string }> {
  const home = path.join(await scratchDirectory('throne-memory-home-'), 'home');
  const repository = path.join(home, repositoryUnderHome);
  await mkdir(repository, { recursive: true });
  return { home, repository };
}

const NATIVE_MEMORY_ROOT = path.join('.throne', 'memories');

test("the throne's own memory directory for a repository under home is named the way memory-dir names it", async () => {
  const { home, repository } = await homeWithRepository(path.join('Documents', 'Development', 'bakery', '.bare'));
  const resolution = await resolveMemoryDir(repository, depsWithHome(home));
  assert.equal(resolution.mode, 'throne-native');
  assert.equal(resolution.path, path.join(home, NATIVE_MEMORY_ROOT, 'Documents-Development-bakery-.bare'));
});

test('a repository outside home keeps its absolute memory slug with a leading dash', async () => {
  const { home } = await homeWithRepository('unused');
  const outside = await scratchDirectory('throne-memory-outside-');
  const resolution = await resolveMemoryDir(outside, depsWithHome(home));
  assert.equal(resolution.path, path.join(home, NATIVE_MEMORY_ROOT, outside.replaceAll(path.sep, '-')));
  assert.ok(path.basename(resolution.path).startsWith('-'));
});

test('a symlinked home gives the same memory slug as the real one', async () => {
  const { home, repository } = await homeWithRepository(path.join('repos', 'app'));
  const linkedHome = path.join(path.dirname(home), 'linked-home');
  await symlink(home, linkedHome);
  const throughLink = await resolveMemoryDir(path.join(linkedHome, 'repos', 'app'), depsWithHome(linkedHome));
  const direct = await resolveMemoryDir(repository, depsWithHome(home));
  assert.equal(throughLink.path, path.join(linkedHome, NATIVE_MEMORY_ROOT, 'repos-app'));
  assert.equal(path.basename(throughLink.path), path.basename(direct.path));
});

test('real git: worktree and subdirectory share the main checkout memory; non-git keys on itself', async () => {
  const { home } = await homeWithRepository('unused');
  const deps = depsWithHome(home);
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

  const expected = throneNativeMemoryDir(home, home, main);
  for (const dir of [main, feature, nested]) {
    const resolution = await resolveMemoryDir(dir, deps);
    assert.equal(resolution.mode, 'throne-native', dir);
    assert.equal(resolution.repoRoot, main, dir);
    assert.equal(resolution.path, expected, dir);
  }

  const plainResolution = await resolveMemoryDir(plain, deps);
  assert.equal(plainResolution.repoRoot, await realpath(plain));
  assert.equal(plainResolution.path, throneNativeMemoryDir(home, home, await realpath(plain)));
});
