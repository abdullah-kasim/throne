import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { readHarnessBackgroundWork } from './harness-background-work.ts';
import { harnessProcessHost, processTableCapture } from './harness-background-work-test-fixtures.ts';

const WORKTREE = await realpath(await mkdtemp(path.join(tmpdir(), 'harness-background-work-')));

test('a harness carrying only its MCP servers and helpers has no background work', async () => {
  for (const capture of ['macos-claude-idle-harness', 'macos-codex-idle-harness']) {
    const host = harnessProcessHost({
      processTable: await processTableCapture(capture),
      harnessDirectory: WORKTREE,
      pidsInHarnessDirectory: capture === 'macos-codex-idle-harness' ? [52790, 52801, 52802] : [],
    });

    assert.deepEqual(await readHarnessBackgroundWork('w1:p3', host), { kind: 'none' }, capture);
  }
});

test('a harness running a background hold script has background work named by its processes', async () => {
  const host = harnessProcessHost({
    processTable: await processTableCapture('macos-claude-harness-with-background-hold-script'),
    harnessDirectory: WORKTREE,
  });

  const work = await readHarnessBackgroundWork('w1:p3', host);

  assert.equal(work.kind, 'running');
  assert.match(work.kind === 'running' ? work.description : '', /sh \.\/hold\.sh; sleep 600/);
  assert.equal(host.hostCommands.some((command) => command.startsWith('lsof')), false);
});

test('a suite started with nohup and left behind by its shell counts only while its cwd is in the harness directory', async () => {
  const processTable = await processTableCapture('macos-claude-harness-with-nohup-suite-in-worktree');
  const inWorktree = harnessProcessHost({ processTable, harnessDirectory: WORKTREE, pidsInHarnessDirectory: [71120, 71135, 71136, 71180] });
  const elsewhere = harnessProcessHost({ processTable, harnessDirectory: WORKTREE });

  const work = await readHarnessBackgroundWork('w1:p3', inWorktree);

  assert.match(work.kind === 'running' ? work.description : '', /^npm test; sh -c node scripts\/run-suite-container\.mjs/);
  assert.deepEqual(await readHarnessBackgroundWork('w1:p3', elsewhere), { kind: 'none' });
});

test('processes of another harness whose cwd sits in the harness directory are not its background work', async () => {
  const host = harnessProcessHost({
    processTable: await processTableCapture('macos-claude-idle-harness-beside-a-scratch-harness-in-its-worktree'),
    harnessDirectory: WORKTREE,
    pidsInHarnessDirectory: [54100, 54120, 54130, 54140, 54150],
  });

  assert.deepEqual(await readHarnessBackgroundWork('w1:p3', host), { kind: 'none' });
});

test('a pane whose harness is missing from the process table cannot be read', async () => {
  const host = harnessProcessHost({
    processTable: await processTableCapture('macos-claude-idle-harness'),
    harnessDirectory: WORKTREE,
  });
  const psWithoutTheHarness = {
    ...host,
    runHostCommand: async (file: string, args: readonly string[]) =>
      (await host.runHostCommand(file, args)).replace(/^52785 .*$/m, ''),
  };

  assert.deepEqual(await readHarnessBackgroundWork('w1:p3', psWithoutTheHarness), { kind: 'unknown' });
});
