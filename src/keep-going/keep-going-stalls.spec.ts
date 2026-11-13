import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { ACCEPTANCE_DATA, type AcceptanceMethod } from '../agentdata/acceptance-data.service.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { claudeProjectDirectory } from '../session/runtime-model-acceptance.ts';
import { aggregateFamilyRecovery, readStallEvidence, STALE_PROGRESS_MS } from './keep-going-stalls.ts';

const NOW_MS = Date.parse('2026-11-10T01:30:05.000Z');
const LONG_AGO_MS = NOW_MS - 2 * STALE_PROGRESS_MS;
const MOMENTS_AGO_MS = NOW_MS - 60_000;
const ALPHA = 'alpha-brd320nov9-01';
const SHADOW = 'shadow-brd320nov9-01-capture';
const CAMPAIGN_KINDS: readonly AcceptanceMethod[] = ['merge', 'verdict'];

const scratchDirectories: string[] = [];
after(async () => {
  for (const directory of scratchDirectories) await rm(directory, { recursive: true, force: true });
});

interface Court {
  readonly dataDir: string;
  readonly projects: string;
}

async function court(): Promise<Court> {
  const root = await mkdtemp(path.join(tmpdir(), 'keep-going-stalls-'));
  scratchDirectories.push(root);
  return { dataDir: path.join(root, 'data'), projects: path.join(root, 'projects') };
}

function cwdOf(name: string): string {
  return `/work/${name}`;
}

async function writeAgent(
  dataDir: string,
  name: string,
  supervisor: string,
  options: { writtenAtMs?: number; report?: string } = {},
): Promise<void> {
  const directory = path.join(dataDir, name);
  await mkdir(directory, { recursive: true });
  const files: Record<string, string> = {
    'identity.md': `# ${name}\n- **Supervisor (routine):** ${supervisor}\n`,
    'spawn.json': JSON.stringify({
      harness: 'claude',
      model: 'opus',
      effort: 2,
      cwd: cwdOf(name),
      spawned_at: '2026-11-09T20:00:00.000Z',
      spawn_finished_at: '2026-11-09T20:00:30.000Z',
      tasked_at: '2026-11-09T20:01:00.000Z',
    }),
    ...(options.report === undefined ? {} : { 'REPORT.md': options.report }),
  };
  const writtenAtMs = options.writtenAtMs ?? LONG_AGO_MS;
  for (const [file, text] of Object.entries(files)) {
    await writeFile(path.join(directory, file), text);
    await utimes(path.join(directory, file), writtenAtMs / 1000, writtenAtMs / 1000);
  }
}

async function writeTranscript(projects: string, name: string, writtenAtMs: number): Promise<void> {
  const directory = claudeProjectDirectory(cwdOf(name), projects);
  await mkdir(directory, { recursive: true });
  const transcript = path.join(directory, 'session.jsonl');
  await writeFile(
    transcript,
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Still working.' }] } }),
  );
  await utimes(transcript, writtenAtMs / 1000, writtenAtMs / 1000);
}

async function reap(dataDir: string, name: string): Promise<void> {
  await mkdir(path.join(dataDir, '.reaped', name), { recursive: true });
  await writeFile(path.join(dataDir, '.reaped', name, 'identity.md'), `# ${name}\n`);
}

function alphaEntry(liveStatus: 'working' | 'idle' | 'blocked'): AgentStatusesRosterEntry {
  return { name: ALPHA, role: 'Alpha', lifecycle: 'live', liveStatus, reportLanded: false, focused: false };
}

function shadowEntry(liveStatus: 'working' | 'idle', reportLanded: boolean): AgentStatusesRosterEntry {
  return { name: SHADOW, role: 'Shadow', lifecycle: 'live', liveStatus, reportLanded, focused: false };
}

async function familiesFor(roster: readonly AgentStatusesRosterEntry[], place: Court) {
  return aggregateFamilyRecovery(await readStallEvidence(roster, NOW_MS, place.dataDir, place.projects));
}

for (const kind of CAMPAIGN_KINDS) {
  test(`an Alpha waiting while its child works is not reported as a stale working Alpha (${kind} campaign)`, async () => {
    const place = await court();
    await writeAgent(place.dataDir, ALPHA, 'Regent');
    await writeAgent(place.dataDir, SHADOW, ALPHA);
    await writeTranscript(place.projects, ALPHA, LONG_AGO_MS);
    await writeTranscript(place.projects, SHADOW, MOMENTS_AGO_MS);

    const families = await familiesFor([alphaEntry('working'), shadowEntry('working', false)], place);

    assert.deepEqual(families, []);
  });

  test(`an Alpha working with no fresh transcript of its own or its child's is still reported as a stale working Alpha (${kind} campaign)`, async () => {
    const place = await court();
    await writeAgent(place.dataDir, ALPHA, 'Regent');
    await writeAgent(place.dataDir, SHADOW, ALPHA);
    await writeTranscript(place.projects, ALPHA, LONG_AGO_MS);
    await writeTranscript(place.projects, SHADOW, LONG_AGO_MS);

    const families = await familiesFor([alphaEntry('working'), shadowEntry('working', false)], place);

    assert.deepEqual(families, [
      { alpha: ALPHA, signatures: [{ alpha: ALPHA, reason: 'stale-working-alpha' }], staleWorkingAlpha: true },
    ]);
  });

  test(`an Alpha idle with a finished child it never accepted is still reported (${kind} campaign)`, async () => {
    const place = await court();
    await writeAgent(place.dataDir, ALPHA, 'Regent');
    await writeAgent(place.dataDir, SHADOW, ALPHA, { report: '# Done\n' });

    const families = await familiesFor([alphaEntry('idle'), shadowEntry('idle', true)], place);

    assert.deepEqual(families, [
      {
        alpha: ALPHA,
        signatures: [{ alpha: ALPHA, child: SHADOW, reason: 'completed-child' }],
        staleWorkingAlpha: false,
      },
    ]);
  });

  test(`a finished child its Alpha already accepted is not a stall (${kind} campaign)`, async () => {
    const place = await court();
    await writeAgent(place.dataDir, ALPHA, 'Regent');
    await writeAgent(place.dataDir, SHADOW, ALPHA, { report: '# Done\n' });
    await ACCEPTANCE_DATA.write(
      SHADOW,
      { acceptedAt: '2026-11-10T01:00:00.000Z', by: ALPHA, how: kind },
      place.dataDir,
    );

    const families = await familiesFor([alphaEntry('idle'), shadowEntry('idle', true)], place);

    assert.deepEqual(families, []);
  });
}

test('a reaped child is not named as a completed child', async () => {
  const place = await court();
  await writeAgent(place.dataDir, ALPHA, 'Regent');
  await reap(place.dataDir, SHADOW);

  const families = await familiesFor([alphaEntry('idle'), shadowEntry('idle', true)], place);

  assert.deepEqual(families, []);
});

test('a reaped Alpha whose pane is still open is not reported as a blocked Alpha', async () => {
  const place = await court();
  await reap(place.dataDir, ALPHA);

  const families = await familiesFor([alphaEntry('blocked')], place);

  assert.deepEqual(families, []);
});

test('an Alpha whose own transcript was written recently is not reported as a stale working Alpha', async () => {
  const place = await court();
  await writeAgent(place.dataDir, ALPHA, 'Regent');
  await writeTranscript(place.projects, ALPHA, MOMENTS_AGO_MS);

  const families = await familiesFor([alphaEntry('working')], place);

  assert.deepEqual(families, []);
});
