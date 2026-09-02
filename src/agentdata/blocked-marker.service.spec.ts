// Requirement: the persisted `blocked.json` record round-trips a
// `blockedBy` list through a write/read cycle.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { readBlockedMarker, writeBlockedMarker } from './blocked-marker.service.ts';

const scratchDirectories: string[] = [];
function scratchDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'throne-blocked-marker-'));
  scratchDirectories.push(directory);
  return directory;
}
after(() => {
  for (const directory of scratchDirectories) rmSync(directory, { recursive: true, force: true });
});

test('a blocked marker written with named children round-trips its exact blockedBy list back out', async () => {
  const dataDir = scratchDataDir();
  await mkdir(join(dataDir, 'alpha-abc'), { recursive: true });
  await writeBlockedMarker('alpha-abc', { blockedBy: ['shadow-1', 'shadow-2'] }, dataDir);

  const marker = await readBlockedMarker('alpha-abc', dataDir);

  assert.ok(marker, 'the marker was written');
  assert.deepEqual(marker!.blockedBy, ['shadow-1', 'shadow-2']);
});

test('a blocked marker written with no named children round-trips as absent', async () => {
  const dataDir = scratchDataDir();
  await mkdir(join(dataDir, 'alpha-xyz'), { recursive: true });
  await writeBlockedMarker('alpha-xyz', {}, dataDir);

  const marker = await readBlockedMarker('alpha-xyz', dataDir);

  assert.ok(marker, 'the marker was written');
  assert.equal(marker!.blockedBy, undefined);
});
