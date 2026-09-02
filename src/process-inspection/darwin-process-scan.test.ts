// Requirement: reap-agent's worktree teardown (and through it the autoreap
// cron) can find the processes a reaped agent left running on macOS. The
// Linux path enumerates `/proc/<pid>/cwd`; on a Mac that directory does not
// exist, the scan returned nothing, and every leftover process under a
// reaped worktree survived — the orphan class the teardown exists to end.
// The Lord's order of 2026-09-02: every autoscaler-family signal supports
// both Linux and mac.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  listProcessesUnderPathDarwin,
  parseLsofCwdRecords,
  parsePsCommandLines,
  type RunHostCommand,
} from './darwin-process-scan.ts';
import { listProcessesUnderPath } from './proc-scan.ts';

// Real directories, because path containment compares realpath identity.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'darwin-scan-')));
const worktree = path.join(root, 'worktree');
const nested = path.join(worktree, 'src');
const sibling = path.join(root, 'worktree-other');
for (const directory of [worktree, nested, sibling]) mkdirSync(directory, { recursive: true });

const LSOF = [
  'p101',
  'fcwd',
  `n${worktree}`,
  'p202',
  'fcwd',
  `n${nested}`,
  'p303',
  'fcwd',
  `n${sibling}`,
  'p404',
  'fcwd',
  'n/',
  'pnot-a-pid',
  'fcwd',
  `n${worktree}`,
  '',
].join('\n');

const PS = [
  '  101 python3 train.py --epochs 900',
  '  202 node dist/src/tools.js keep-going',
  '  303 bash',
  '  404 /sbin/launchd',
].join('\n');

const fakeRun: RunHostCommand = async (file, args) => {
  if (file === 'lsof') {
    assert.deepEqual(args, ['-a', '-d', 'cwd', '-Fpn']);
    return LSOF;
  }
  if (file === 'ps') {
    assert.deepEqual(args, ['-axo', 'pid=,args=']);
    return PS;
  }
  throw new Error(`unexpected host command ${file}`);
};

test('lsof -Fpn records parse to pid -> cwd, ignoring malformed pid lines', () => {
  const parsed = parseLsofCwdRecords(LSOF);
  assert.equal(parsed.get(101), worktree);
  assert.equal(parsed.get(202), nested);
  assert.equal(parsed.get(404), '/');
  assert.equal(parsed.size, 4);
});

test('ps pid=,args= output parses to pid -> command line', () => {
  const parsed = parsePsCommandLines(PS);
  assert.equal(parsed.get(101), 'python3 train.py --epochs 900');
  assert.equal(parsed.get(404), '/sbin/launchd');
});

test('only processes whose cwd is the worktree or beneath it are listed', async () => {
  const listed = await listProcessesUnderPathDarwin(worktree, fakeRun);
  assert.deepEqual(
    listed.map((entry) => [entry.pid, entry.cwd, entry.cmdline, entry.cwdDeleted]),
    [
      [101, worktree, 'python3 train.py --epochs 900', false],
      [202, nested, 'node dist/src/tools.js keep-going', false],
    ],
  );
  // `worktree-other` shares the string prefix but is a sibling, not a child.
  assert.ok(!listed.some((entry) => entry.pid === 303));
});

test('a pid lsof saw but ps did not still lists, with the command line marked unavailable', async () => {
  const run: RunHostCommand = async (file) => (file === 'lsof' ? LSOF : '');
  const listed = await listProcessesUnderPathDarwin(worktree, run);
  assert.equal(listed.length, 2);
  assert.equal(listed[0]!.cmdline, '(command line unavailable)');
});

test('listProcessesUnderPath routes darwin to the lsof/ps scan and linux to /proc', async () => {
  // A /proc root that does not exist: the linux path must try (and fail on)
  // it rather than silently answering from lsof, and the darwin path must
  // never touch it.
  const missingProcRoot = path.join(root, 'no-such-proc');
  await assert.rejects(listProcessesUnderPath(worktree, missingProcRoot, 'linux'));
  // The darwin route runs the real lsof/ps here; this test process's own cwd
  // is not under the fixture worktree, so an empty answer is the truthful one
  // — and reaching it proves the route did not read `missingProcRoot`.
  if (process.platform === 'darwin') {
    const listed = await listProcessesUnderPath(worktree, missingProcRoot, 'darwin');
    assert.deepEqual(listed, []);
  }
});
