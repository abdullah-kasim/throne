// Requirement: the resolver defers to any memory convention already in force
// (in-tree, project-declared, the operator's own tool) and only then falls
// back to the throne's machine-local root; every mode keys on the main
// checkout so worktrees and subdirectories share one directory.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatMemoryStandingInstruction,
  memorySlug,
  resolveMemoryDir,
  type MemoryResolverDeps,
} from './memory-dir-resolver.ts';

interface FakeWorld {
  commonDirs?: Record<string, string>;
  existing?: string[];
  files?: Record<string, string>;
  executables?: Record<string, string>;
  toolOutput?: string;
  realpaths?: Record<string, string>;
}

function fakeDeps(world: FakeWorld): MemoryResolverDeps & { toolCalls: string[][] } {
  const toolCalls: string[][] = [];
  return {
    toolCalls,
    gitCommonDir: async (dir) => world.commonDirs?.[dir],
    pathExists: async (candidate) => (world.existing ?? []).includes(candidate),
    readText: async (file) => world.files?.[file],
    findExecutable: async (name) => world.executables?.[name],
    runExecutable: async (executable, args) => {
      toolCalls.push([executable, ...args]);
      return `${world.toolOutput ?? '/home/op/.memories/-home-op-repos-app'}\n`;
    },
    realpath: async (candidate) => world.realpaths?.[candidate] ?? candidate,
    homeDir: () => '/home/op',
  };
}

const MAIN = '/home/op/repos/app';
const WORKTREE = '/home/op/.throne/worktrees/app/feature';
const WORKTREE_COMMON = { [WORKTREE]: `${MAIN}/.git` };

test('a linked worktree resolves to the main checkout and the throne-native slug', async () => {
  const resolution = await resolveMemoryDir(WORKTREE, fakeDeps({ commonDirs: WORKTREE_COMMON }));
  assert.equal(resolution.mode, 'throne-native');
  assert.equal(resolution.repoRoot, MAIN);
  assert.equal(resolution.path, '/home/op/.throne/memories/-home-op-repos-app');
});

test('a subdirectory of the main checkout collapses to the same root via a relative common dir', async () => {
  const sub = `${MAIN}/src/deep`;
  const resolution = await resolveMemoryDir(sub, fakeDeps({
    commonDirs: { [sub]: '../../.git' },
    realpaths: { [`${sub}/../../.git`]: `${MAIN}/.git` },
  }));
  assert.equal(resolution.repoRoot, MAIN);
});

test('a bare repository is its own identity', async () => {
  const bareWorktree = '/home/op/wt';
  const resolution = await resolveMemoryDir(bareWorktree, fakeDeps({
    commonDirs: { [bareWorktree]: '/srv/git/app.git' },
  }));
  assert.equal(resolution.repoRoot, '/srv/git/app.git');
  assert.equal(resolution.path, '/home/op/.throne/memories/-srv-git-app.git');
});

test('outside any git repository the directory itself is the identity (non-git projects are real)', async () => {
  const resolution = await resolveMemoryDir('/home/op/notes', fakeDeps({}));
  assert.equal(resolution.mode, 'throne-native');
  assert.equal(resolution.repoRoot, '/home/op/notes');
  assert.equal(resolution.path, '/home/op/.throne/memories/-home-op-notes');
});

test('a symlinked path is resolved to its physical form before slugging', async () => {
  const resolution = await resolveMemoryDir('/home/op/link', fakeDeps({
    realpaths: { '/home/op/link': '/home/op/notes' },
  }));
  assert.equal(resolution.repoRoot, '/home/op/notes');
});

test('an in-tree agent_docs/MEMORY wins over everything, inside the worktree the agent owns', async () => {
  const resolution = await resolveMemoryDir(WORKTREE, fakeDeps({
    commonDirs: WORKTREE_COMMON,
    existing: [`${MAIN}/agent_docs/MEMORY`],
    executables: { 'memory-dir': '/usr/local/bin/memory-dir' },
    files: { [`${MAIN}/AGENTS.md`]: 'use memory-dir' },
  }));
  assert.equal(resolution.mode, 'in-tree');
  assert.equal(resolution.path, `${MAIN}/agent_docs/MEMORY`);
});

test('a project directive plus the operator tool runs the tool from the physical cwd', async () => {
  const deps = fakeDeps({
    commonDirs: WORKTREE_COMMON,
    files: { [`${MAIN}/AGENTS.md`]: '# Project\n\nWrite corrections to "$(memory-dir)".\n' },
    executables: { 'memory-dir': '/usr/local/bin/memory-dir' },
  });
  const resolution = await resolveMemoryDir(WORKTREE, deps);
  assert.equal(resolution.mode, 'project-declared');
  assert.equal(resolution.path, '/home/op/.memories/-home-op-repos-app');
  assert.equal(resolution.evidence, `${MAIN}/AGENTS.md:3 (via /usr/local/bin/memory-dir)`);
  assert.deepEqual(deps.toolCalls, [['/usr/local/bin/memory-dir', WORKTREE]]);
  assert.equal(resolution.warning, undefined);
});

test('a project directive without the tool falls back to throne-native WITH a warning naming file:line', async () => {
  const resolution = await resolveMemoryDir(WORKTREE, fakeDeps({
    commonDirs: WORKTREE_COMMON,
    files: { [`${MAIN}/CLAUDE.md`]: 'Memory lives under ~/.memories per team convention.' },
  }));
  assert.equal(resolution.mode, 'project-declared');
  assert.equal(resolution.path, '/home/op/.throne/memories/-home-op-repos-app');
  assert.match(resolution.warning ?? '', new RegExp(`${MAIN}/CLAUDE.md:1`));
  assert.match(resolution.warning ?? '', /~\/\.memories/);
});

test('prose mentioning "memory" is not a directive', async () => {
  const resolution = await resolveMemoryDir(WORKTREE, fakeDeps({
    commonDirs: WORKTREE_COMMON,
    files: { [`${MAIN}/CLAUDE.md`]: 'Keep memory usage low; the service is memory-bound.' },
  }));
  assert.equal(resolution.mode, 'throne-native');
});

test('the operator tool alone gives external mode with its output verbatim', async () => {
  const deps = fakeDeps({
    commonDirs: WORKTREE_COMMON,
    executables: { 'memory-dir': '/home/op/.local/bin/memory-dir' },
    toolOutput: '/home/op/.memories/-home-op-repos-app',
  });
  const resolution = await resolveMemoryDir(WORKTREE, deps);
  assert.equal(resolution.mode, 'external');
  assert.equal(resolution.path, '/home/op/.memories/-home-op-repos-app');
  assert.equal(resolution.evidence, '/home/op/.local/bin/memory-dir');
});

test('a tool that prints garbage is an error, never a relative memory path', async () => {
  await assert.rejects(
    resolveMemoryDir(WORKTREE, fakeDeps({
      commonDirs: WORKTREE_COMMON,
      executables: { 'memory-dir': '/x/memory-dir' },
      toolOutput: 'oops',
    })),
    /printed "oops"/,
  );
});

test('memorySlug keeps the leading dash', () => {
  assert.equal(memorySlug('/a/b'), '-a-b');
});

test('the standing instruction names the path, mode and evidence, and carries the warning', () => {
  const text = formatMemoryStandingInstruction({
    mode: 'project-declared',
    path: '/home/op/.throne/memories/-home-op-repos-app',
    repoRoot: MAIN,
    evidence: `${MAIN}/CLAUDE.md:1`,
    warning: 'read CLAUDE.md',
  });
  assert.match(text, /`\/home\/op\/\.throne\/memories\/-home-op-repos-app`/);
  assert.match(text, /mode project-declared/);
  assert.match(text, /WARNING: read CLAUDE.md/);
  assert.match(text, /throne memory-dir --json/);
});

test('an unresolved memory (resumed agent) yields the command-only instruction, never a fabricated path', () => {
  const text = formatMemoryStandingInstruction(undefined);
  assert.match(text, /was not resolved at spawn/);
  assert.match(text, /throne memory-dir --json/);
  assert.doesNotMatch(text, /\.throne\/memories/);
});
