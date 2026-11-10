import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { launchScriptText } from '../herdr/herdr-launch-command.ts';
import { isLaunchCleanupOfHarness, readHarnessBackgroundWork } from './harness-background-work.ts';
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

const HARNESS_LINE = '52785 52148 52785 /usr/local/bin/claude --dangerously-skip-permissions --model opus --name shadow-bakery-01';
const PANE_SHELL_LINE = '52148  1200 52148 -bash';
const REAPER_PROGRAM = 'harness_pid=$1 shift while kill -0 "$harness_pid" 2>/dev/null; do   sleep 1 done rm -rf -- "$@"';

function reaperLine(pid: number, parentPid: number, watchedPid: number): string {
  return `${pid} ${parentPid} ${pid} bash -c ${REAPER_PROGRAM} throne-reaper ${watchedPid} /home/agent/tmp/throne-herdr-launch-8AZz60`;
}

function processTable(...lines: string[]): string {
  return [PANE_SHELL_LINE, HARNESS_LINE, ...lines].join('\n');
}

const OWN_REAPER_AND_SLEEP = [reaperLine(52790, 52785, 52785), '52791 52790 52790 sleep 1'];

test('an idle agent whose only extra processes are its own launch reaper and its sleep has no background work', async () => {
  const host = harnessProcessHost({ processTable: processTable(...OWN_REAPER_AND_SLEEP), harnessDirectory: WORKTREE });

  assert.deepEqual(await readHarnessBackgroundWork('w1:p3', host), { kind: 'none' });
});

test('the launch reaper is not background work even when it runs in the agent\'s worktree', async () => {
  const host = harnessProcessHost({
    processTable: processTable(reaperLine(52790, 1, 52785), '52791 52790 52790 sleep 1'),
    harnessDirectory: WORKTREE,
    pidsInHarnessDirectory: [52790, 52791],
  });

  assert.deepEqual(await readHarnessBackgroundWork('w1:p3', host), { kind: 'none' });
});

test('a real background job beside the launch reaper is still background work', async () => {
  const host = harnessProcessHost({
    processTable: processTable(...OWN_REAPER_AND_SLEEP, '52800 52785 52800 node scripts/run-suite-container.mjs'),
    harnessDirectory: WORKTREE,
  });

  const work = await readHarnessBackgroundWork('w1:p3', host);

  assert.equal(work.kind === 'running' ? work.description : work.kind, 'node scripts/run-suite-container.mjs');
});

test('a process named like the reaper but watching another harness still counts as background work', async () => {
  const host = harnessProcessHost({
    processTable: processTable(reaperLine(52790, 52785, 61000), '52791 52790 52790 sleep 1'),
    harnessDirectory: WORKTREE,
  });

  const work = await readHarnessBackgroundWork('w1:p3', host);

  assert.equal(work.kind, 'running');
  assert.match(work.kind === 'running' ? work.description : '', /throne-reaper|sleep 1/);
});

test('the reaper line the launcher writes is recognised as the agent\'s own cleanup', async () => {
  const script = launchScriptText({ argv: ['claude'] }, ['/home/agent/tmp/throne-herdr-launch-8AZz60']);
  const launchedReaper = /\{ setsid bash -c [\s\S]*?\} \|\| :/.exec(script)?.[0];
  assert.ok(launchedReaper);
  const argvPrinter = launchedReaper
    .replace('setsid bash -c', "printf '%s\\0' bash -c")
    .replace(/<\/dev\/null >\/dev\/null 2>&1 & \} \|\| :$/, '; }');
  const argv = (await promisify(execFile)('bash', ['-c', `harness_pid=52785\n${argvPrinter}`])).stdout
    .split('\0')
    .filter((argument) => argument !== '');
  const reaper = { pid: 52790, parentPid: 52785, processGroupId: 52790, command: argv.join(' ').replaceAll('\n', ' ') };
  const sleep = { pid: 52791, parentPid: 52790, processGroupId: 52790, command: 'sleep 1' };

  assert.equal(isLaunchCleanupOfHarness(reaper, 52785, undefined), true);
  assert.equal(isLaunchCleanupOfHarness(sleep, 52785, reaper), true);
  assert.equal(isLaunchCleanupOfHarness(reaper, 61000, undefined), false);
});
