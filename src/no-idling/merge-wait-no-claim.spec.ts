import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  clearBlockedMarker,
  readBlockedMarker,
  writeBlockedMarker,
} from '../agentdata/blocked-marker.service.ts';
import type { AcceptanceMethod } from '../agentdata/acceptance-data.service.ts';
import { resolveBlockedTag, type BlockedMarkerLedger } from './blocked-marker-resolution.ts';
import { readSupervisorWaits } from './claim-wait.ts';
import { findReapabilityProtocolViolations } from './reapability-protocol.ts';
import { rosterEntry } from './no-idling-command-test-fixtures.ts';

const SHADOW = 'shadow-holdw-r2c';
const ALPHA = 'alpha-holdwaitproof-02';
const PAGED_AT_MS = Date.parse('2026-11-11T12:41:27.000Z');
const SENDS_TO_THE_SUPERVISOR = [
  { timestamp: '2026-11-11T12:28:04.000Z', recipient: ALPHA, id: 25370, transport: 'sqlite' },
  { timestamp: '2026-11-11T12:28:39.000Z', recipient: ALPHA, id: 25373, transport: 'sqlite' },
];
const CAMPAIGN_KINDS: readonly AcceptanceMethod[] = ['merge', 'verdict'];

async function withLedger(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'merge-wait-no-claim-'));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function writeShadowThatReportedDone(
  dataDir: string,
  how: AcceptanceMethod,
  blockedOnItsSupervisor: boolean,
): Promise<void> {
  const dir = path.join(dataDir, SHADOW);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'identity.md'),
    `# ${SHADOW}\n\n- **Role:** Shadow\n- **Supervisor (routine):** ${ALPHA}\n`,
  );
  await writeFile(
    path.join(dir, 'sent-messages.jsonl'),
    SENDS_TO_THE_SUPERVISOR.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
  if (how === 'verdict') await writeFile(path.join(dir, 'REPORT.md'), 'DONE\n');
  if (blockedOnItsSupervisor) await writeBlockedMarker(SHADOW, { blockedBy: [ALPHA] }, dataDir);
}

function ledgerIn(dataDir: string): BlockedMarkerLedger {
  return {
    readBlockedMarker: (name) => readBlockedMarker(name, dataDir),
    writeBlockedMarker: (name, blockedBy) =>
      writeBlockedMarker(name, blockedBy === undefined ? undefined : { blockedBy }, dataDir),
    clearBlockedMarker: (name) => clearBlockedMarker(name, dataDir),
  };
}

async function sweepThatReadsThePaneAsUnmarked(dataDir: string): Promise<readonly { agent: string; reason: string }[]> {
  const roster = [rosterEntry(SHADOW, 'Shadow', 'idle')];
  const waits = await readSupervisorWaits(roster, dataDir);
  const tag = await resolveBlockedTag(SHADOW, async () => ({ kind: 'unmarked' }), ledgerIn(dataDir));
  return findReapabilityProtocolViolations(
    roster,
    new Map([[SHADOW, tag]]),
    new Set(),
    new Set(),
    new Map([[SHADOW, ALPHA]]),
    waits,
    PAGED_AT_MS,
  );
}

for (const how of CAMPAIGN_KINDS) {
  test(`a ${how} Shadow that reported DONE and waits for its merge is not reported for having no claim`, async () => {
    await withLedger(async (dataDir) => {
      await writeShadowThatReportedDone(dataDir, how, true);
      assert.deepEqual(await sweepThatReadsThePaneAsUnmarked(dataDir), []);
    });
  });
}

test('a merge Shadow that messaged its supervisor but never declared itself blocked is still reported for having no claim', async () => {
  await withLedger(async (dataDir) => {
    await writeShadowThatReportedDone(dataDir, 'merge', false);
    assert.deepEqual(await sweepThatReadsThePaneAsUnmarked(dataDir), [
      { agent: SHADOW, reason: 'idle-with-no-claim' },
    ]);
  });
});
