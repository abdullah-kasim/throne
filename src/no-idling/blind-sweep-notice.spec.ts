import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { runNoIdling } from './no-idling-run.ts';
import { deps, rosterEntry } from './no-idling-command-test-fixtures.ts';

const REAPER = 'throne-reaper 4100 (pid 4101)';
const BUILD = 'npm run build (pid 5200)';

function corrected(name: string, role: string, description: string): AgentStatusesRosterEntry {
  return {
    ...rosterEntry(name, role, 'working'),
    backgroundWorkCorrection: { reportedStatus: 'idle', description },
  };
}

const blindRoster = [
  corrected('alpha-bakery-01', 'Alpha', REAPER),
  corrected('shadow-bakery-01-oven', 'Shadow', REAPER),
  corrected('shadow-bakery-02-flour', 'Shadow', BUILD),
];

const seeingRoster = [
  corrected('alpha-bakery-01', 'Alpha', REAPER),
  rosterEntry('shadow-bakery-01-oven', 'Shadow', 'idle'),
];

async function blindNoticesAfter(rosters: readonly (readonly AgentStatusesRosterEntry[])[]): Promise<string[]> {
  let roster = rosters[0]!;
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [...roster],
    blindSweepMemory: { blindSweepsInARow: 0, noticeSent: false },
  });
  for (const next of rosters) {
    roster = next;
    await runNoIdling(dependencies, { notify: true });
  }
  return submitCalls.map((call) => call.prompt).filter((prompt) => prompt.includes('cannot see idle agents'));
}

const sweeps = (count: number, roster: readonly AgentStatusesRosterEntry[]) =>
  Array.from({ length: count }, () => roster);

test('the Regent is told once when every live Alpha and Shadow has been corrected to working for ten sweeps in a row', async () => {
  assert.equal((await blindNoticesAfter(sweeps(9, blindRoster))).length, 0);
  assert.equal((await blindNoticesAfter(sweeps(10, blindRoster))).length, 1);
});

test('the blind-sweep notice names the commonest process', async () => {
  const [notice] = await blindNoticesAfter(sweeps(10, blindRoster));

  assert.ok(notice!.includes(REAPER));
  assert.ok(!notice!.includes(BUILD));
});

test('the blind-sweep notice is not sent a second time in the same backend lifetime', async () => {
  const rosters = [...sweeps(10, blindRoster), seeingRoster, ...sweeps(15, blindRoster)];

  assert.equal((await blindNoticesAfter(rosters)).length, 1);
});

test('one live agent that is not corrected restarts the count of blind sweeps', async () => {
  const rosters = [...sweeps(9, blindRoster), seeingRoster, ...sweeps(9, blindRoster)];

  assert.equal((await blindNoticesAfter(rosters)).length, 0);
});
