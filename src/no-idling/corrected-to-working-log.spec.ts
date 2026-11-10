import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { runNoIdling } from './no-idling-run.ts';
import { deps, rosterEntry } from './no-idling-command-test-fixtures.ts';

const SHADOW = 'shadow-bakery-01-oven';
const ALPHA = 'alpha-bakery-01';
const SLEEP_JOB = 'sleep 600 (pid 4242)';

function correctedShadow(): AgentStatusesRosterEntry {
  return {
    ...rosterEntry(SHADOW, 'Shadow', 'working'),
    backgroundWorkCorrection: { reportedStatus: 'idle', description: SLEEP_JOB },
  };
}

async function sweepLinesAt(times: readonly number[]): Promise<string[]> {
  const lines: string[] = [];
  let nowMs = 0;
  const { dependencies } = deps({
    getRoster: async () => [rosterEntry(ALPHA, 'Alpha', 'working'), correctedShadow()],
    now: () => nowMs,
    stdout: (text) => lines.push(text),
    correctedToWorkingLogTimes: new Map<string, number>(),
  });
  for (const time of times) {
    nowMs = time;
    await runNoIdling(dependencies, { notify: true });
  }
  return lines.filter((line) => line.includes('counted as working'));
}

test('the idle sweep names an agent the roster corrected to working and the process that caused it', async () => {
  const lines = await sweepLinesAt([1_000]);

  assert.deepEqual(lines, [
    `no-idling: ${SHADOW} reported idle by herdr, counted as working because it is running ${SLEEP_JOB}\n`,
  ]);
});

test('the idle sweep names the same corrected agent at most once an hour', async () => {
  const minute = 60_000;
  const lines = await sweepLinesAt([0, minute, 59 * minute, 60 * minute, 61 * minute]);

  assert.equal(lines.length, 2);
});
