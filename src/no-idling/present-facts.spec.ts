import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { readAgentPresentState } from '../agentdata/agent-present-state.ts';
import type { SpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import { UNCHANGED_OBSERVATION_REPAGE_INTERVAL_MS } from '../blocked-paging/blocked-agent-escalation-ledger.ts';
import { claudeProjectDirectory } from '../session/runtime-model-acceptance.ts';
import type { NoIdlingDependencies } from './no-idling-dependencies.types.ts';
import { runNoIdling } from './no-idling-run.ts';
import { deps, rosterEntry } from './no-idling-command-test-fixtures.ts';
import { inMemoryPageLedger } from './present-facts.ts';
import { splitStaleAndStrandedThroneTabs, type StaleTabReport } from './stale-tab-report.ts';

const NOW_MS = Date.parse('2026-11-10T12:00:00.000Z');
const UNTASKED = /spawned but never tasked/;
const scratchDirectories: string[] = [];
after(async () => {
  for (const directory of scratchDirectories) await rm(directory, { recursive: true, force: true });
});

interface Scratch {
  readonly dataDir: string;
  readonly claudeProjectsDirectory: string;
}

async function scratch(): Promise<Scratch> {
  const root = await mkdtemp(path.join(tmpdir(), 'no-idling-present-facts-'));
  scratchDirectories.push(root);
  return { dataDir: path.join(root, 'data'), claudeProjectsDirectory: path.join(root, 'projects') };
}

function spawnSpec(name: string, spawnedAt: string, finishedAt: string): SpawnSpec {
  return {
    harness: 'claude',
    model: 'opus',
    effort: 2,
    cwd: `/work/${name}`,
    session_id: `session-${name}`,
    spawned_at: spawnedAt,
    spawn_finished_at: finishedAt,
    tasked_at: '2026-11-10T09:00:00.000Z',
  } as SpawnSpec;
}

async function writeLiveAgent(sources: Scratch, name: string, identity: string): Promise<void> {
  await mkdir(path.join(sources.dataDir, name), { recursive: true });
  await writeFile(
    path.join(sources.dataDir, name, 'spawn.json'),
    JSON.stringify(spawnSpec(name, '2026-11-10T09:00:00.000Z', '2026-11-10T09:01:00.000Z')),
  );
  await writeFile(path.join(sources.dataDir, name, 'identity.md'), identity);
}

async function writeReapedAgent(sources: Scratch, name: string): Promise<void> {
  await mkdir(path.join(sources.dataDir, '.reaped', name), { recursive: true });
  await writeFile(path.join(sources.dataDir, '.reaped', name, 'identity.md'), '# identity\n');
}

async function writeTranscript(sources: Scratch, name: string, writtenAtMs: number): Promise<void> {
  const directory = claudeProjectDirectory(`/work/${name}`, sources.claudeProjectsDirectory);
  await mkdir(directory, { recursive: true });
  const transcript = path.join(directory, `session-${name}.jsonl`);
  await writeFile(
    transcript,
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } }),
  );
  await utimes(transcript, writtenAtMs / 1000, writtenAtMs / 1000);
}

function presentStateFrom(sources: Scratch): NoIdlingDependencies['readPresentState'] {
  return (name, nowMs) => readAgentPresentState(name, nowMs, sources);
}

async function pagesNamingIdleAlphas(
  sources: Scratch,
  names: readonly string[],
  overrides: Partial<NoIdlingDependencies> = {},
): Promise<string[]> {
  const { dependencies, submitCalls } = deps({
    getRoster: async () => names.map((name) => rosterEntry(name, 'Alpha', 'idle')),
    readPresentState: presentStateFrom(sources),
    now: () => NOW_MS,
    ...overrides,
  });
  await runNoIdling(dependencies, { notify: true });
  return submitCalls
    .map((call) => call.prompt)
    .filter((prompt) => names.some((name) => prompt.includes(name)));
}

const REAPED_ALPHAS_PAGED_BY_THE_REGENT_ALARMS = [
  'alpha-recapown-01',
  'alpha-harnesstrim-01',
  'alpha-notesconn-01',
  'alpha-quietblind-01',
  'alpha-mapseams-01',
  'alpha-rptheadnum-01',
  'alpha-rptcheapfix-01',
  'alpha-rptclosefix-01',
  'alpha-rptfixjudge-01',
];

test('a reaped Alpha whose pane outlived the reap is not paged', async () => {
  const sources = await scratch();
  for (const name of REAPED_ALPHAS_PAGED_BY_THE_REGENT_ALARMS) await writeReapedAgent(sources, name);

  assert.deepEqual(await pagesNamingIdleAlphas(sources, REAPED_ALPHAS_PAGED_BY_THE_REGENT_ALARMS), []);
});

test('a reaped Alpha whose cwd was removed is not paged', async () => {
  const sources = await scratch();
  await writeReapedAgent(sources, 'alpha-rptfixjudge-01');

  assert.deepEqual(
    await pagesNamingIdleAlphas(sources, ['alpha-rptfixjudge-01'], { checkCwdExists: async () => false }),
    [],
  );
});

test('a live merging Alpha idle by pane and by transcript is still paged', async () => {
  const sources = await scratch();
  await writeLiveAgent(sources, 'alpha-merging-01', '- **Role:** Alpha\n');
  await writeTranscript(sources, 'alpha-merging-01', NOW_MS - 20 * 60_000);

  const pages = await pagesNamingIdleAlphas(sources, ['alpha-merging-01']);

  assert.equal(pages.length, 1);
  assert.match(pages[0]!, /alpha-merging-01/);
});

test('a live verdict-only Alpha whose branch never advanced is judged by its activity, not by a missing merge', async () => {
  const sources = await scratch();
  await writeLiveAgent(sources, 'alpha-verdict-01', '- **Role:** Alpha\n- **deliverable_shape:** verdict-only\n');
  await writeTranscript(sources, 'alpha-verdict-01', NOW_MS - 30_000);
  await writeLiveAgent(sources, 'alpha-verdict-02', '- **Role:** Alpha\n- **deliverable_shape:** verdict-only\n');
  await writeTranscript(sources, 'alpha-verdict-02', NOW_MS - 20 * 60_000);

  const pages = await pagesNamingIdleAlphas(sources, ['alpha-verdict-01', 'alpha-verdict-02']);

  assert.equal(pages.length, 1);
  assert.doesNotMatch(pages[0]!, /alpha-verdict-01/);
  assert.match(pages[0]!, /alpha-verdict-02/);
});

test('an Alpha whose pane reads idle but whose transcript was written a moment ago is not paged', async () => {
  const sources = await scratch();
  await writeLiveAgent(sources, 'alpha-merging-02', '- **Role:** Alpha\n');
  await writeTranscript(sources, 'alpha-merging-02', NOW_MS - 30_000);

  assert.deepEqual(await pagesNamingIdleAlphas(sources, ['alpha-merging-02']), []);
});

test('an unchanged idle observation is paged once and again only after the stated interval', async () => {
  const sources = await scratch();
  await writeLiveAgent(sources, 'alpha-merging-03', '- **Role:** Alpha\n');
  await writeTranscript(sources, 'alpha-merging-03', NOW_MS - 20 * 60_000);
  const pageLedger = inMemoryPageLedger();
  let nowMs = NOW_MS;
  const sweep = () => pagesNamingIdleAlphas(sources, ['alpha-merging-03'], { pageLedger, now: () => nowMs });

  assert.equal((await sweep()).length, 1);
  nowMs += 60_000;
  assert.equal((await sweep()).length, 0);
  nowMs = NOW_MS + UNCHANGED_OBSERVATION_REPAGE_INTERVAL_MS;
  assert.equal((await sweep()).length, 1);
});

test('a changed idle observation is paged at once', async () => {
  const sources = await scratch();
  await writeLiveAgent(sources, 'alpha-merging-04', '- **Role:** Alpha\n');
  await writeLiveAgent(sources, 'alpha-merging-05', '- **Role:** Alpha\n');
  const pageLedger = inMemoryPageLedger();

  assert.equal((await pagesNamingIdleAlphas(sources, ['alpha-merging-04'], { pageLedger })).length, 1);
  assert.equal(
    (await pagesNamingIdleAlphas(sources, ['alpha-merging-04', 'alpha-merging-05'], { pageLedger })).length,
    1,
  );
});

async function untaskedPages(spec: SpawnSpec, reportLanded: boolean, nowMs: number): Promise<string[]> {
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [{ ...rosterEntry('shadow-rptdraw-01-rule', 'Shadow', 'idle'), reportLanded }],
    readSpawnSpec: async () => spec,
    now: () => nowMs,
  });
  await runNoIdling(dependencies, { notify: true });
  return submitCalls.map((call) => call.prompt).filter((prompt) => /tasked/.test(prompt));
}

const SPAWN_THAT_FINISHED_AT_07_51_00: SpawnSpec = {
  ...spawnSpec('shadow-rptdraw-01-rule', '2026-11-11T07:49:58.247Z', '2026-11-11T07:51:00.833Z'),
  tasked_at: null,
};

test('a Shadow whose spawn finished seconds ago is not reported as untasked', async () => {
  assert.deepEqual(
    await untaskedPages(SPAWN_THAT_FINISHED_AT_07_51_00, false, Date.parse('2026-11-11T07:51:48.000Z')),
    [],
  );
});

test('a Shadow still untasked after its spawn grace is still reported as untasked', async () => {
  const pages = await untaskedPages(SPAWN_THAT_FINISHED_AT_07_51_00, false, Date.parse('2026-11-11T07:55:00.000Z'));

  assert.equal(pages.length, 1);
  assert.match(pages[0]!, UNTASKED);
});

test('a Shadow that finished and whose DONE was refused is reported as finished and waiting on its supervisor, not as never tasked', async () => {
  const spec = {
    ...spawnSpec('shadow-brd510nov10-01-capture', '2026-11-10T12:10:30.462Z', '2026-11-10T12:11:46.720Z'),
    tasked_at: null,
  };
  const pages = await untaskedPages(spec, true, Date.parse('2026-11-10T13:31:03.000Z'));

  assert.equal(pages.length, 1);
  assert.doesNotMatch(pages[0]!, UNTASKED);
  assert.match(pages[0]!, /finished and wrote REPORT\.md/);
  assert.match(pages[0]!, /waiting on its supervisor/);
});

function staleCandidate(label: string): StaleTabReport {
  return { label, tabId: `tab-${label}`, paneCount: 1, reason: `label exactly matches a throne ledger agent name (${label})` };
}

async function staleTabsFor(label: string, spawnedAgoMs: number): Promise<StaleTabReport[]> {
  const spawnedAt = new Date(Date.now() - spawnedAgoMs).toISOString();
  const { staleTabs } = await splitStaleAndStrandedThroneTabs(
    [staleCandidate(label)],
    new Set([label]),
    [{ paneId: `pane-${label}`, tabId: `tab-${label}`, terminalId: `term-${label}` }],
    '/data',
    {
      readVisibleAnsi: async () => '',
      fileExists: async () => false,
      readSpawnSpec: async () => spawnSpec(label, spawnedAt, spawnedAt),
    },
  );
  return staleTabs;
}

test('a tab spawned seconds ago is not offered for closing', async () => {
  for (const label of ['alpha-maplib-01', 'shadow-tipshide-01-apply', 'shadow-pageadd-99a-conform', 'shadow-rptheadnum-99a-conform-r2', 'shadow-brd510lim-06-fresh', 'shadow-rptsize-99a-conform']) {
    assert.deepEqual(await staleTabsFor(label, 10_000), []);
  }
});

test('a tab still without a live agent after its spawn grace is still reported', async () => {
  const staleTabs = await staleTabsFor('shadow-rptsize-99a-conform', 10 * 60_000);

  assert.deepEqual(staleTabs.map((tab) => tab.label), ['shadow-rptsize-99a-conform']);
});
