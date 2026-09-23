import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_RECALL_CONFIG,
  type RecallConfig,
} from '../relevance-classifier/recall-user-config.ts';
import { RECALL_LEDGER_FILE_NAME } from '../memory-recall/recall-records.ts';
import { runLocate, type LocateDependencies, type LocatedCandidate } from './locate.command.ts';

const STAGE_ONE_CANDIDATES: LocatedCandidate[] = [
  { path: 'src/a.ts', reasons: ['matches:revoke'], score: 3 },
  { path: 'src/b.ts', reasons: ['path:revoke'], score: 2 },
  { path: 'src/c.ts', reasons: ['history:revoke'], score: 0 },
];

const STAGE_TWO_CANDIDATES: LocatedCandidate[] = [
  { path: 'src/a.ts', reasons: ['matches:revoke'], score: 0.1 },
  { path: 'src/b.ts', reasons: ['path:revoke'], score: 0.9 },
  { path: 'src/c.ts', reasons: ['history:revoke'], score: 0.05 },
];

interface Fixture {
  readonly dependencies: LocateDependencies;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly dataDirectory: string;
  readonly gatherCalls: Array<{ task: string; roots: readonly string[]; opts: { budget?: number } }>;
  readonly judgeCalls: Array<{ candidates: readonly LocatedCandidate[]; task: string }>;
}

function fixture(): Fixture {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), 'locate-command-test-'));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const gatherCalls: Fixture['gatherCalls'] = [];
  const judgeCalls: Fixture['judgeCalls'] = [];
  const dependencies: LocateDependencies = {
    loadConfig: () => Promise.resolve(DEFAULT_RECALL_CONFIG as RecallConfig),
    readJevSwitch: () =>
      Promise.resolve({
        on: false,
        enabledInConfig: false,
        disabledByEnvironment: false,
        keyFile: 'not-checked',
        keyFilePath: '~/.jev-key',
      }),
    gatherCandidates: (task, roots, opts) => {
      gatherCalls.push({ task, roots, opts });
      return Promise.resolve(STAGE_ONE_CANDIDATES.map((candidate) => ({ ...candidate })));
    },
    judgeCandidates: (candidates, task) => {
      judgeCalls.push({ candidates, task });
      return Promise.resolve(STAGE_TWO_CANDIDATES);
    },
    dataDirectory,
    now: () => new Date('2026-09-22T00:00:00.000Z'),
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
  };
  return { dependencies, stdout, stderr, dataDirectory, gatherCalls, judgeCalls };
}

test('locate entrance validation refuses an unknown flag', async () => {
  const { dependencies, stderr } = fixture();
  const exitCode = await runLocate(['--nonsense'], dependencies);
  assert.equal(exitCode, 2);
  assert.match(stderr.join(''), /unknown flag "--nonsense"/);
});

test('locate entrance validation requires a task unless --status is given', async () => {
  const { dependencies, stderr } = fixture();
  const exitCode = await runLocate(['--root', '/tmp'], dependencies);
  assert.equal(exitCode, 2);
  assert.match(stderr.join(''), /the task is required/);
});

test('locate entrance validation requires at least one --root', async () => {
  const { dependencies, stderr } = fixture();
  const exitCode = await runLocate(['revoke a session'], dependencies);
  assert.equal(exitCode, 2);
  assert.match(stderr.join(''), /at least one --root/);
});

test('locate entrance validation refuses --status combined with another flag', async () => {
  const { dependencies, stderr } = fixture();
  const exitCode = await runLocate(['--status', '--json'], dependencies);
  assert.equal(exitCode, 2);
  assert.match(stderr.join(''), /--status must be given alone/);
});

test('locate --status prints the resolved backend and exits', async () => {
  const { dependencies, stdout } = fixture();
  const exitCode = await runLocate(['--status'], dependencies);
  assert.equal(exitCode, 0);
  assert.match(stdout.join(''), /rules/i);
});

test('locate defaults to stage-1 ordering, not the judged probability', async () => {
  const { dependencies, stdout } = fixture();
  const exitCode = await runLocate(['revoke a session', '--root', '/repo', '--min', '0'], dependencies);
  assert.equal(exitCode, 0);
  const printed = stdout.join('');
  assert.match(printed, /src\/a\.ts {2}p=1\.00 {2}matches:revoke/);
  const lines = printed.trim().split('\n');
  assert.equal(lines[0]?.startsWith('src/a.ts'), true);
});

test('locate normalizes the default stage-1 score into a genuine 0-1 probability', async () => {
  const { dependencies, stdout } = fixture();
  await runLocate(['revoke a session', '--root', '/repo', '--min', '0'], dependencies);
  const printed = stdout.join('');
  const probabilities = printed
    .trim()
    .split('\n')
    .map((line) => Number(line.match(/p=([\d.]+)/)?.[1]));
  for (const probability of probabilities) {
    assert.equal(Number.isNaN(probability), false);
    assert.equal(probability >= 0 && probability <= 1, true);
  }
  assert.deepEqual(probabilities, [1, 0.67, 0]);
});

test('locate applies the real default --min threshold to exclude low-scoring candidates', async () => {
  const { dependencies, stdout } = fixture();
  dependencies.gatherCandidates = () =>
    Promise.resolve([
      { path: 'src/a.ts', reasons: ['matches:revoke'], score: 9 },
      { path: 'src/b.ts', reasons: ['path:revoke'], score: 3 },
      { path: 'src/c.ts', reasons: ['history:revoke'], score: 1 },
    ]);
  await runLocate(['revoke a session', '--root', '/repo'], dependencies);
  const printed = stdout.join('');
  assert.match(printed, /src\/a\.ts/);
  assert.doesNotMatch(printed, /src\/b\.ts/);
  assert.doesNotMatch(printed, /src\/c\.ts/);
});

test('locate calls judgeCandidates so its reason annotation still runs, even though ordering ignores it', async () => {
  const { dependencies, judgeCalls } = fixture();
  await runLocate(['revoke a session', '--root', '/repo'], dependencies);
  assert.equal(judgeCalls.length, 1);
  assert.equal(judgeCalls[0]?.task, 'revoke a session');
});

test('locate respects --top and --json', async () => {
  const { dependencies, stdout } = fixture();
  await runLocate(['revoke a session', '--root', '/repo', '--json', '--top', '1', '--min', '0'], dependencies);
  const parsed = JSON.parse(stdout.join('')) as Array<{ path: string }>;
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.path, 'src/a.ts');
});

test('locate applies --budget to what stage 1 forwards', async () => {
  const { dependencies, gatherCalls } = fixture();
  await runLocate(['revoke a session', '--root', '/repo', '--budget', '5'], dependencies);
  assert.equal(gatherCalls[0]?.opts.budget, 5);
});

test('locate appends a ledger entry for a successful non-status invocation', async () => {
  const { dependencies, dataDirectory } = fixture();
  await runLocate(['revoke a session', '--root', '/repo', '--min', '0'], dependencies);
  const ledger = readFileSync(path.join(dataDirectory, RECALL_LEDGER_FILE_NAME), 'utf8');
  const line = JSON.parse(ledger.trim().split('\n')[0] ?? '{}') as { command: string };
  assert.equal(line.command, 'locate');
});
