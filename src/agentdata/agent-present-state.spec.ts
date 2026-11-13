import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  BLOCKED_PAGE_ESCALATION_BOUND,
  UNCHANGED_OBSERVATION_REPAGE_INTERVAL_MS,
  blockedPageEscalationState,
  shouldPageObservation,
  type BlockedPageLedgerEntry,
} from '../blocked-paging/blocked-agent-escalation-ledger.ts';
import { claudeProjectDirectory } from '../session/runtime-model-acceptance.ts';
import { readAgentPresentState } from './agent-present-state.ts';
import type { SpawnSpec } from './spawn-data-contracts.ts';

const NOW_MS = Date.parse('2026-11-10T12:00:00.000Z');
const scratchDirectories: string[] = [];
after(async () => {
  for (const directory of scratchDirectories) await rm(directory, { recursive: true, force: true });
});

async function scratch(): Promise<{ dataDir: string; claudeProjectsDirectory: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-present-state-'));
  scratchDirectories.push(root);
  return { dataDir: path.join(root, 'data'), claudeProjectsDirectory: path.join(root, 'projects') };
}

function spawnSpec(cwd: string, spawnedAt: string, finished: boolean): SpawnSpec {
  return {
    harness: 'claude',
    model: 'opus',
    effort: 2,
    cwd,
    spawned_at: spawnedAt,
    spawn_finished_at: finished ? spawnedAt : null,
    tasked_at: null,
  } as SpawnSpec;
}

async function writeAgent(dataDir: string, name: string, spec: SpawnSpec, files: Record<string, string> = {}): Promise<void> {
  await mkdir(path.join(dataDir, name), { recursive: true });
  await writeFile(path.join(dataDir, name, 'spawn.json'), JSON.stringify(spec));
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(dataDir, name, file), text);
}

async function writeTranscript(projects: string, cwd: string, lines: readonly object[], writtenAtMs: number): Promise<void> {
  const directory = claudeProjectDirectory(cwd, projects);
  await mkdir(directory, { recursive: true });
  const transcript = path.join(directory, 'session.jsonl');
  await writeFile(transcript, lines.map((line) => JSON.stringify(line)).join('\n'));
  await utimes(transcript, writtenAtMs / 1000, writtenAtMs / 1000);
}

test('an agent whose ledger was archived on reap reads as reaped even while its pane is still open', async () => {
  const sources = await scratch();
  await mkdir(path.join(sources.dataDir, '.reaped', 'alpha-rptsize-01'), { recursive: true });
  await writeFile(path.join(sources.dataDir, '.reaped', 'alpha-rptsize-01', 'identity.md'), '# identity\n');

  const state = await readAgentPresentState('alpha-rptsize-01', NOW_MS, sources);

  assert.equal(state.reaped, true);
  assert.equal(state.withinSpawnGrace, false);
});

test('an agent with a live ledger beside an older archive of the same name is not reaped', async () => {
  const sources = await scratch();
  await mkdir(path.join(sources.dataDir, '.reaped', 'shadow-rptsize-01'), { recursive: true });
  await writeFile(path.join(sources.dataDir, '.reaped', 'shadow-rptsize-01', 'identity.md'), '# identity\n');
  await writeAgent(sources.dataDir, 'shadow-rptsize-01', spawnSpec('/work/shadow-rptsize-01', '2026-11-10T11:00:00.000Z', true));

  assert.equal((await readAgentPresentState('shadow-rptsize-01', NOW_MS, sources)).reaped, false);
});

test('a merging shadow reads its last transcript write and last assistant text', async () => {
  const sources = await scratch();
  const cwd = '/work/shadow-merging-01';
  await writeAgent(sources.dataDir, 'shadow-merging-01', spawnSpec(cwd, '2026-11-10T11:00:00.000Z', true));
  const writtenAtMs = NOW_MS - 20_000;
  await writeTranscript(sources.claudeProjectsDirectory, cwd, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Running the suite.' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Committed; reporting DONE.' }] } },
  ], writtenAtMs);

  const state = await readAgentPresentState('shadow-merging-01', NOW_MS, sources);

  assert.equal(state.reaped, false);
  assert.equal(Math.round(state.lastTranscriptWriteMs ?? 0), writtenAtMs);
  assert.equal(state.lastText, 'Committed; reporting DONE.');
  assert.equal(state.spawnAgeMs, 3_600_000);
  assert.equal(state.withinSpawnGrace, false);
});

test('a verdict-only shadow whose branch never advanced is live and not reaped for lacking a merge', async () => {
  const sources = await scratch();
  const cwd = '/work/shadow-verdictreport-01';
  await writeAgent(sources.dataDir, 'shadow-verdictreport-01', spawnSpec(cwd, '2026-11-10T11:00:00.000Z', true), {
    'REPORT.md': '# Verdict\nNo changes; findings only.\n',
  });
  await writeTranscript(sources.claudeProjectsDirectory, cwd, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Verdict written.' }] } },
  ], NOW_MS - 5_000);

  const state = await readAgentPresentState('shadow-verdictreport-01', NOW_MS, sources);

  assert.equal(state.reaped, false);
  assert.equal(state.lastText, 'Verdict written.');
});

test('an agent whose transcript cannot be read is not read as idle', async () => {
  const sources = await scratch();
  await writeAgent(sources.dataDir, 'shadow-unread-01', spawnSpec('/work/shadow-unread-01', '2026-11-10T11:00:00.000Z', true));

  const state = await readAgentPresentState('shadow-unread-01', NOW_MS, sources);

  assert.equal(state.lastTranscriptWriteMs, undefined);
  assert.equal(state.lastText, undefined);
  assert.equal(state.reaped, false);
});

test('an agent spawned under ninety seconds ago is within its spawn grace', async () => {
  const sources = await scratch();
  await writeAgent(sources.dataDir, 'shadow-young-01', spawnSpec('/work/shadow-young-01', '2026-11-10T11:59:00.000Z', true));

  assert.equal((await readAgentPresentState('shadow-young-01', NOW_MS, sources)).withinSpawnGrace, true);
});

test('an agent whose spawn is still starting past ninety seconds is within its spawn grace', async () => {
  const sources = await scratch();
  await writeAgent(sources.dataDir, 'shadow-booting-01', spawnSpec('/work/shadow-booting-01', '2026-11-10T11:57:00.000Z', false));

  assert.equal((await readAgentPresentState('shadow-booting-01', NOW_MS, sources)).withinSpawnGrace, true);
});

test('an agent finished spawning more than ninety seconds ago is past its spawn grace', async () => {
  const sources = await scratch();
  await writeAgent(sources.dataDir, 'shadow-old-01', spawnSpec('/work/shadow-old-01', '2026-11-10T11:57:00.000Z', true));

  assert.equal((await readAgentPresentState('shadow-old-01', NOW_MS, sources)).withinSpawnGrace, false);
});

function paged(pageKey: string, fingerprint: string, observedAtMs: number, agentName = 'shadow-a'): BlockedPageLedgerEntry {
  return { agentName, kind: 'page-enqueued', pageKey, fingerprint, observedAt: new Date(observedAtMs).toISOString() };
}

test('an observation paged once is not paged again unchanged before the interval', () => {
  const entries = [paged('blocked-agent-paging:shadow-a', 'blocked-at-11:50', NOW_MS - 60_000)];

  assert.equal(shouldPageObservation('blocked-agent-paging:shadow-a', 'blocked-at-11:50', NOW_MS, entries), false);
  assert.equal(
    shouldPageObservation(
      'blocked-agent-paging:shadow-a',
      'blocked-at-11:50',
      NOW_MS - 60_000 + UNCHANGED_OBSERVATION_REPAGE_INTERVAL_MS,
      entries,
    ),
    true,
  );
});

test('a changed observation is paged at once', () => {
  const entries = [paged('blocked-agent-paging:shadow-a', 'blocked-at-11:50', NOW_MS - 60_000)];

  assert.equal(shouldPageObservation('blocked-agent-paging:shadow-a', 'blocked-at-11:58', NOW_MS, entries), true);
  assert.equal(shouldPageObservation('blocked-agent-paging:shadow-b', 'blocked-at-11:50', NOW_MS, entries), true);
});

test('the escalation bound still stops a fourth page about one agent', () => {
  const entries = [1, 2, 3].map((index) => paged(`blocked-agent-paging:shadow-a:${index}`, `fingerprint-${index}`, NOW_MS - index));

  const state = blockedPageEscalationState('shadow-a', entries);

  assert.equal(state.pageCount, BLOCKED_PAGE_ESCALATION_BOUND);
  assert.ok(state.pageCount >= BLOCKED_PAGE_ESCALATION_BOUND, 'a fourth page is refused at the bound');
});
