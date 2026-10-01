import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { REAPED_DIR_NAME } from '../agentdata/ledger-data.service.ts';
import { MEMORY_READ_LOG_FILE_NAME } from './recall-report-logs.ts';
import {
  buildReportFixture,
  copyOfFixtureData,
  reportOn,
  topicBackend,
} from './recall-report.test-support.ts';

interface FixtureAgent {
  readonly name: string;
  readonly harness: string;
  readonly spawnedAt: string;
  readonly cwd: string;
  readonly reaped?: boolean;
}

const FIXTURE = buildReportFixture([]);

async function agentLedgerWith(agents: readonly FixtureAgent[]): Promise<string> {
  const agentLedgerDirectory = await mkdtemp(path.join(tmpdir(), 'recall-report-agents-'));
  for (const agent of agents) {
    const agentDirectory = agent.reaped === true
      ? path.join(agentLedgerDirectory, REAPED_DIR_NAME, agent.name)
      : path.join(agentLedgerDirectory, agent.name);
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(path.join(agentDirectory, 'identity.md'), `# Identity — ${agent.name}\n`);
    await writeFile(
      path.join(agentDirectory, 'spawn.json'),
      JSON.stringify({
        harness: agent.harness,
        model: 'some-model',
        effort: 3,
        cwd: agent.cwd,
        spawned_at: agent.spawnedAt,
      }),
    );
  }
  return agentLedgerDirectory;
}

function supportingLine(output: string, startsWith: string): string | undefined {
  return output.split('\n').find((line) => line.startsWith(startsWith));
}

test('agents that ran on a harness with no recall logging are counted as unmeasured sessions', async () => {
  const insideTheWindow = '2026-10-01T08:00:00.000Z';
  const agentLedgerDirectory = await agentLedgerWith([
    { name: 'shadow-baker-01', harness: 'claude', spawnedAt: insideTheWindow, cwd: '/work/baker' },
    { name: 'shadow-baker-02', harness: 'claudey-all-omni', spawnedAt: insideTheWindow, cwd: '/work/baker' },
    { name: 'alpha-florist-01', harness: 'codex', spawnedAt: insideTheWindow, cwd: '/work/florist' },
    { name: 'shadow-florist-02', harness: 'codex', spawnedAt: insideTheWindow, cwd: '/work/florist', reaped: true },
    { name: 'shadow-florist-03', harness: 'codexy-all-omni', spawnedAt: insideTheWindow, cwd: '/work/florist' },
    { name: 'shadow-tailor-01', harness: 'opencode', spawnedAt: insideTheWindow, cwd: '/work/tailor' },
    { name: 'alpha-early-01', harness: 'codex', spawnedAt: '2026-09-20T08:00:00.000Z', cwd: '/work/early' },
  ]);

  const { output, exitCode } = await reportOn(FIXTURE, {
    backend: topicBackend(),
    flags: ['--since', '2026-09-30'],
    agentLedgerDirectory,
  });

  assert.equal(exitCode, 0, output);
  assert.equal(
    supportingLine(output, '  unmeasured sessions:'),
    '  unmeasured sessions: 4 (agents spawned on a harness with no recall or read logging, by harness: codex 2, codexy-all-omni 1, opencode 1)',
  );
});

test('a read with no agent name is attributed through its pane or transcript directory, and the rest are reported as still unattributed', async () => {
  const projectsDirectory = await mkdtemp(path.join(tmpdir(), 'recall-report-projects-'));
  const agentLedgerDirectory = await agentLedgerWith([
    { name: 'shadow-painter-01', harness: 'claude', spawnedAt: '2026-10-01T08:00:00.000Z', cwd: '/work/painter' },
    { name: 'stager-first', harness: 'claude', spawnedAt: '2026-10-01T08:00:00.000Z', cwd: '/work/court' },
    { name: 'stager-second', harness: 'claude', spawnedAt: '2026-10-01T08:00:00.000Z', cwd: '/work/court', reaped: true },
  ]);
  const dataDirectory = copyOfFixtureData(FIXTURE);
  const read = (minute: string, fields: object): object => ({
    at: `2026-10-01T10:${minute}:00.000Z`,
    sessionId: null,
    agentName: null,
    herdrPaneId: null,
    transcriptPath: null,
    tool: 'Read',
    kind: 'read',
    memoryFiles: [FIXTURE.memoryPath('RED.md')],
    returnedSomething: true,
    readInFull: true,
    cwd: null,
    ...fields,
  });
  await appendFile(
    path.join(dataDirectory, MEMORY_READ_LOG_FILE_NAME),
    [
      read('40', { agentName: 'shadow-sculptor-01', herdrPaneId: 'w1:p7' }),
      read('41', { herdrPaneId: 'w1:p7' }),
      read('42', { transcriptPath: path.join(projectsDirectory, '-work-painter', 'painter-session.jsonl') }),
      read('43', { transcriptPath: path.join(projectsDirectory, '-work-court', 'court-session.jsonl') }),
      read('44', { herdrPaneId: 'w1:p9' }),
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join(''),
  );

  const { output, exitCode } = await reportOn(FIXTURE, {
    backend: topicBackend(),
    dataDirectory,
    agentLedgerDirectory,
  });

  assert.equal(exitCode, 0, output);
  assert.equal(
    supportingLine(output, '  memory reads with no agent name:'),
    '  memory reads with no agent name: 2 attributed through their herdr pane or transcript directory, 5 still unattributed',
  );
});
