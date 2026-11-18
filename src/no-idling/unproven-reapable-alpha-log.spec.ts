import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runNoIdling } from './no-idling-run.ts';
import { declaredState, deps, rosterEntry, stateFiles } from './no-idling-command-test-fixtures.ts';

const ALPHA = 'alpha-bakery-01';
const SKIPPED_LINE = `no-idling: ${ALPHA} is reapable but has no proven delivery record; Regent not paged by the sweep\n`;

async function sweepLines(hasProvenDelivery: boolean): Promise<string[]> {
  const lines: string[] = [];
  const { dependencies } = deps({
    getRoster: async () => [rosterEntry(ALPHA, 'Alpha', 'idle')],
    readAgentState: stateFiles({ [ALPHA]: declaredState('reapable', { reapableReason: 'completed' }) }),
    hasProvenDelivery: async () => hasProvenDelivery,
    stdout: (text) => lines.push(text),
  });
  await runNoIdling(dependencies, { notify: true });
  return lines;
}

test('the sweep says so when it skips a reapable Alpha that has no proven delivery record', async () => {
  assert.ok((await sweepLines(false)).includes(SKIPPED_LINE));
});

test('the sweep says nothing about a reapable Alpha that has a proven delivery record', async () => {
  const lines = await sweepLines(true);
  assert.ok(!lines.includes(SKIPPED_LINE));
  assert.ok(lines.some((line) => line.includes(`reap completed Alpha(s) ${ALPHA}`)));
});
