import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  HARNESS_BACKGROUND_WORK_KINDS,
  inOneProcessTablePass,
  REAL_HARNESS_BACKGROUND_WORK_HOST,
  readHarnessBackgroundWork,
  type HarnessBackgroundWorkHost,
} from './harness-background-work.ts';
import { harnessProcessHost, processTableCapture } from './harness-background-work-test-fixtures.ts';
import { DEFAULT_PROC_ROOT, listProcessSnapshots, PROCESS_READ_BATCH_SIZE, readProcessIdentity } from './proc-scan.ts';
import { readLinuxProcessTable, type ReadProcessTable } from './process-table.ts';

const ON_LINUX = process.platform === 'linux';

test('checking whether agents are busy on Linux starts no child process', { skip: !ON_LINUX }, async () => {
  const hostCommands: string[] = [];
  const host: HarnessBackgroundWorkHost = {
    readPaneProcessInfo: async (paneId) => ({
      paneId,
      foregroundProcesses: [{ name: 'claude', argv: ['claude'], cwd: process.cwd(), pid: process.pid }],
    }),
    runHostCommand: async (file, args) => {
      hostCommands.push([file, ...args].join(' '));
      return '';
    },
    readProcessTable: REAL_HARNESS_BACKGROUND_WORK_HOST.readProcessTable,
  };

  const work = await readHarnessBackgroundWork('w1:p3', host);

  assert.notEqual(work.kind, HARNESS_BACKGROUND_WORK_KINDS.UNKNOWN);
  assert.deepEqual(hostCommands, []);
});

test('every pane in one pass shares one read of the process table', async () => {
  const fixtureHost = harnessProcessHost({
    processTable: await processTableCapture('macos-claude-harness-with-nohup-suite-in-worktree'),
    harnessDirectory: '/worktree',
  });
  let tableReads = 0;
  const countedRead: ReadProcessTable = async (runHostCommand) => {
    tableReads += 1;
    return fixtureHost.readProcessTable(runHostCommand);
  };
  const host = { ...fixtureHost, readProcessTable: countedRead };

  await inOneProcessTablePass(() =>
    Promise.all(['w1:p1', 'w1:p2', 'w1:p3'].map((paneId) => readHarnessBackgroundWork(paneId, host))));

  assert.equal(tableReads, 1);
  assert.equal(fixtureHost.hostCommands.filter((command) => command.startsWith('lsof')).length, 1);
});

test('a process scan never holds more than a small batch of processes\' files open at once', { skip: !ON_LINUX }, async () => {
  let reading = 0;
  let mostAtOnce = 0;
  const scanned = await listProcessSnapshots(DEFAULT_PROC_ROOT, async (pid, procRoot) => {
    reading += 1;
    mostAtOnce = Math.max(mostAtOnce, reading);
    try {
      return await readProcessIdentity(pid, procRoot);
    } finally {
      reading -= 1;
    }
  });

  assert.ok(scanned.length > 0);
  assert.ok(mostAtOnce <= PROCESS_READ_BATCH_SIZE, `${mostAtOnce} processes read at once`);
});

async function writeFakeProcess(procRoot: string, process: { pid: number; parentPid: number; argv: readonly string[] }): Promise<void> {
  const processDirectory = path.join(procRoot, String(process.pid));
  await mkdir(processDirectory);
  const fieldsAfterParentPid = [process.pid, ...Array.from({ length: 16 }, () => 0), 1000];
  await writeFile(
    path.join(processDirectory, 'stat'),
    `${process.pid} (${path.basename(process.argv[0]!)}) S ${process.parentPid} ${fieldsAfterParentPid.join(' ')}\n`,
  );
  await writeFile(path.join(processDirectory, 'cmdline'), `${process.argv.join('\0')}\0`);
}

test('an agent whose only extra process is its launch clean-up reads as not busy when the process table comes from /proc', async () => {
  const procRoot = await mkdtemp(path.join(tmpdir(), 'fake-proc-'));
  await writeFile(path.join(procRoot, 'stat'), 'btime 1700000000\n');
  const cleanupProgram = 'harness_pid=$1\nshift\nwhile kill -0 "$harness_pid" 2>/dev/null; do\n  sleep 1\ndone\nrm -rf -- "$@"';
  await Promise.all([
    writeFakeProcess(procRoot, { pid: 52148, parentPid: 1200, argv: ['-bash'] }),
    writeFakeProcess(procRoot, { pid: 52785, parentPid: 52148, argv: ['/usr/local/bin/claude', '--dangerously-skip-permissions'] }),
    writeFakeProcess(procRoot, { pid: 52790, parentPid: 52785, argv: ['bash', '-c', cleanupProgram, 'throne-reaper', '52785', '/home/agent/tmp/throne-herdr-launch-8AZz60'] }),
    writeFakeProcess(procRoot, { pid: 52791, parentPid: 52790, argv: ['sleep', '1'] }),
  ]);
  const host: HarnessBackgroundWorkHost = {
    readPaneProcessInfo: async (paneId) => ({
      paneId,
      foregroundProcesses: [{ name: 'claude', argv: ['/usr/local/bin/claude'], cwd: procRoot, pid: 52785 }],
    }),
    runHostCommand: async () => '',
    readProcessTable: () => readLinuxProcessTable(procRoot),
  };

  assert.deepEqual(await readHarnessBackgroundWork('w1:p3', host), { kind: HARNESS_BACKGROUND_WORK_KINDS.NONE });
});
