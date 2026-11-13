import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { SpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import { IdentityLineReadStatus } from '../agentdata/identity-data.service.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { findFullyIdleFamilies } from './idle-family.ts';
import { readAgentsWithinSpawnGrace } from './idle-family-evidence-assembly.ts';
import { findReapabilityProtocolViolations } from './reapability-protocol.ts';
import {
  classifyStrandedSpawnPane,
  strandedSpawnEvidenceFromSpawnRecord,
} from './stranded-spawn-classification.ts';
import { rosterEntry } from './no-idling-command-test-fixtures.ts';

const NOW_MS = Date.parse('2026-11-11T12:00:00.000Z');
const ALPHA = 'alpha-grace-01';
const SHADOW = 'shadow-grace-01';
const TEN_MINUTES_MS = 600_000;
const THIRTY_SECONDS_MS = 30_000;
const SOURCE_ROOT = path.join(import.meta.dirname, '..');
const EMPTY_CODEX_COMPOSER = path.join(SOURCE_ROOT, '..', 'test', 'fixtures', 'codex-idle-pane-with-chrome.ansi');

function isoAgo(ageMs: number): string {
  return new Date(NOW_MS - ageMs).toISOString();
}

function spawnSpec(spawnedAgoMs: number, finishedAgoMs: number | null): SpawnSpec {
  return {
    harness: 'claude',
    model: 'opus',
    effort: 1,
    cwd: '/throne/grace',
    spawned_at: isoAgo(spawnedAgoMs),
    spawn_finished_at: finishedAgoMs === null ? null : isoAgo(finishedAgoMs),
    tasked_at: null,
  } as SpawnSpec;
}

function supervisedBy(supervisor: string) {
  return { status: IdentityLineReadStatus.Found, value: supervisor } as never;
}

function verdictOnlyShadow(): AgentStatusesRosterEntry {
  return { ...rosterEntry(SHADOW, 'Shadow', 'idle'), reportLanded: false };
}

async function graceOf(specs: Record<string, SpawnSpec>): Promise<ReadonlySet<string>> {
  const roster = Object.keys(specs).map((name) => rosterEntry(name, name.startsWith('alpha') ? 'Alpha' : 'Shadow', 'idle'));
  return readAgentsWithinSpawnGrace(roster, '/unused', async (name) => specs[name] ?? null, () => NOW_MS);
}

async function idleFamilies(specs: Record<string, SpawnSpec>) {
  const roster = [rosterEntry(ALPHA, 'Alpha', 'idle'), verdictOnlyShadow()];
  return findFullyIdleFamilies({
    roster,
    supervisors: new Map([[SHADOW, supervisedBy(ALPHA)]]),
    withinSpawnGrace: await graceOf(specs),
    lastMessageTags: new Map([[ALPHA, { kind: 'unmarked' }], [SHADOW, { kind: 'unmarked' }]]),
    confirmedNoLiveChildrenAlphaNames: new Set(),
  } as never);
}

test('an idle family past its grace is still reported', async () => {
  const families = await idleFamilies({
    [ALPHA]: spawnSpec(TEN_MINUTES_MS, TEN_MINUTES_MS),
    [SHADOW]: spawnSpec(TEN_MINUTES_MS, TEN_MINUTES_MS),
  });
  assert.deepEqual(families.map((family) => family.alpha), [ALPHA]);
});

test('an idle family whose spawn finished under ninety seconds ago is not yet judged', async () => {
  const families = await idleFamilies({
    [ALPHA]: spawnSpec(TEN_MINUTES_MS, THIRTY_SECONDS_MS),
    [SHADOW]: spawnSpec(TEN_MINUTES_MS, TEN_MINUTES_MS),
  });
  assert.deepEqual(families, []);
});

test('a spawn that is still starting stays in its grace past ninety seconds', async () => {
  const grace = await graceOf({ [SHADOW]: spawnSpec(2 * 60_000, null) });
  assert.equal(grace.has(SHADOW), true);
});

async function reapabilityViolationsFor(spec: SpawnSpec, entry: AgentStatusesRosterEntry) {
  return findReapabilityProtocolViolations(
    [rosterEntry(ALPHA, 'Alpha', 'working'), entry],
    new Map([[SHADOW, { kind: 'unmarked' }]]),
    new Set(),
    await graceOf({ [SHADOW]: spec }),
    new Map([[SHADOW, ALPHA]]),
    new Map(),
    NOW_MS,
  );
}

for (const [campaign, entry] of [
  ['merging', rosterEntry(SHADOW, 'Shadow', 'idle')],
  ['verdict-only', verdictOnlyShadow()],
] as const) {
  test(`a reapability violation past its grace is still reported for a ${campaign} Shadow`, async () => {
    const violations = await reapabilityViolationsFor(spawnSpec(TEN_MINUTES_MS, TEN_MINUTES_MS), entry);
    assert.deepEqual(violations.map((violation) => violation.reason), ['idle-with-no-claim']);
  });

  test(`a ${campaign} Shadow whose spawn finished under ninety seconds ago is not yet judged for reapability`, async () => {
    const violations = await reapabilityViolationsFor(spawnSpec(TEN_MINUTES_MS, THIRTY_SECONDS_MS), entry);
    assert.deepEqual(violations, []);
  });
}

test('a spawn stranded past its grace is still reported', async () => {
  const pane = await readFile(EMPTY_CODEX_COMPOSER, 'utf8');
  const stranded = strandedSpawnEvidenceFromSpawnRecord(spawnSpec(TEN_MINUTES_MS, TEN_MINUTES_MS), NOW_MS);
  const justFinished = strandedSpawnEvidenceFromSpawnRecord(spawnSpec(TEN_MINUTES_MS, THIRTY_SECONDS_MS), NOW_MS);
  assert.equal(classifyStrandedSpawnPane('codex', pane, true, stranded), 'STRANDED_SPAWN');
  assert.equal(classifyStrandedSpawnPane('codex', pane, true, justFinished), undefined);
});

async function sourceFilesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test('every idle check uses the one spawn grace rule', async () => {
  const filesComparingAgeThemselves: string[] = [];
  for (const file of await sourceFilesUnder(SOURCE_ROOT)) {
    if (file.endsWith(path.join('agentdata', 'spawn-starting.ts'))) continue;
    if ((await readFile(file, 'utf8')).includes('AGENT_MIN_AGE_MS')) {
      filesComparingAgeThemselves.push(path.relative(SOURCE_ROOT, file));
    }
  }
  assert.deepEqual(filesComparingAgeThemselves, []);
});
