// Requirement: `throne memory-dir` always prints exactly one absolute
// directory on stdout in text mode so `ls "$(throne memory-dir)"` composes,
// `--json` carries the mode and evidence, `--create` is the only thing that
// mkdirs, warnings go to stderr, and bad input is a steered exit 2.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runMemoryDir, type MemoryDirDependencies } from '../src/memory-dir/memory-dir.command.ts';
import type { MemoryResolution } from '../src/memory-dir/memory-dir-resolver.ts';

const RESOLVED: MemoryResolution = {
  mode: 'throne-native',
  path: '/home/op/.throne/memories/-home-op-repos-app',
  repoRoot: '/home/op/repos/app',
  evidence: 'nothing else declared',
};

function harness(resolution: MemoryResolution | Error = RESOLVED) {
  const out: string[] = [];
  const err: string[] = [];
  const created: string[] = [];
  const resolvedFrom: string[] = [];
  const dependencies: MemoryDirDependencies = {
    resolve: async (dir) => {
      resolvedFrom.push(dir);
      if (resolution instanceof Error) throw resolution;
      return resolution;
    },
    resolverDeps: {} as MemoryDirDependencies['resolverDeps'],
    createDirectory: async (dir) => {
      created.push(dir);
    },
    cwd: () => '/home/op/repos/app/src',
    writeStdout: (text) => out.push(text),
    writeStderr: (text) => err.push(text),
  };
  return { dependencies, out, err, created, resolvedFrom };
}

test('text mode prints the path alone and resolves from cwd by default', async () => {
  const h = harness();
  assert.equal(await runMemoryDir([], h.dependencies), 0);
  assert.deepEqual(h.out, [`${RESOLVED.path}\n`]);
  assert.deepEqual(h.err, []);
  assert.deepEqual(h.resolvedFrom, ['/home/op/repos/app/src']);
  assert.deepEqual(h.created, []);
});

test('DIR argument replaces cwd; --json prints the whole resolution; --create mkdirs', async () => {
  const h = harness();
  assert.equal(await runMemoryDir(['--json', '--create', '/elsewhere'], h.dependencies), 0);
  assert.deepEqual(h.resolvedFrom, ['/elsewhere']);
  assert.deepEqual(JSON.parse(h.out[0] as string), RESOLVED);
  assert.deepEqual(h.created, [RESOLVED.path]);
});

test('a warning goes to stderr while stdout still carries exactly the path', async () => {
  const h = harness({ ...RESOLVED, mode: 'project-declared', warning: 'read AGENTS.md:3' });
  assert.equal(await runMemoryDir([], h.dependencies), 0);
  assert.deepEqual(h.out, [`${RESOLVED.path}\n`]);
  assert.match(h.err.join(''), /WARNING: read AGENTS.md:3/);
});

test('an unknown flag or a second DIR is a steered exit 2', async () => {
  for (const args of [['--bogus'], ['a', 'b']]) {
    const h = harness();
    assert.equal(await runMemoryDir(args, h.dependencies), 2, args.join(' '));
    assert.match(h.err.join(''), /Usage: \.\/bin\/throne-cli memory-dir/);
    assert.match(h.err.join(''), /supervisor/);
    assert.deepEqual(h.out, []);
  }
});

test('a resolver failure is a steered exit 2 with the cause', async () => {
  const h = harness(new Error('ENOENT: no such directory'));
  assert.equal(await runMemoryDir(['/missing'], h.dependencies), 2);
  assert.match(h.err.join(''), /ENOENT/);
  assert.deepEqual(h.out, []);
});
