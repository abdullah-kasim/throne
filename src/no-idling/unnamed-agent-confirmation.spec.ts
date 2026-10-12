import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfirmedObservationTracker } from './confirmed-observation.ts';
import { confirmUnnamedAgents } from './unnamed-agent-confirmation.ts';

function unnamedPane(paneId: string, agentSessionId?: string) {
  return { paneId, agentSessionId, tabLabel: `label-${paneId}` };
}

test('a pane seen unnamed on one sweep is not reported yet', () => {
  const tracker = new ConfirmedObservationTracker();

  assert.deepEqual(confirmUnnamedAgents([unnamedPane('w1:p1', 'session-1')], tracker), []);
});

test('a pane seen unnamed on two consecutive sweeps is reported', () => {
  const tracker = new ConfirmedObservationTracker();
  confirmUnnamedAgents([unnamedPane('w1:p1', 'session-1'), unnamedPane('w1:p2')], tracker);
  const secondSweep = [unnamedPane('w1:p1', 'session-1'), unnamedPane('w1:p2')];

  const confirmed = confirmUnnamedAgents(secondSweep, tracker);

  assert.equal(confirmed.length, 2);
  assert.equal(confirmed[0], secondSweep[0]);
  assert.equal(confirmed[1], secondSweep[1]);
});

test('a pane renamed between two unnamed sightings is not reported on the second sighting', () => {
  const tracker = new ConfirmedObservationTracker();
  confirmUnnamedAgents([unnamedPane('w1:p1', 'session-1')], tracker);
  confirmUnnamedAgents([], tracker);

  assert.deepEqual(confirmUnnamedAgents([unnamedPane('w1:p1', 'session-1')], tracker), []);
});

test('a new agent session in the same pane starts its own two-sweep wait', () => {
  const tracker = new ConfirmedObservationTracker();
  confirmUnnamedAgents([unnamedPane('w1:p1', 'session-1')], tracker);

  assert.deepEqual(confirmUnnamedAgents([unnamedPane('w1:p1', 'session-2')], tracker), []);
  assert.deepEqual(confirmUnnamedAgents([unnamedPane('w1:p1')], tracker), []);
});

test('a confirmed unnamed pane stays reported on every later sweep while it is still unnamed', () => {
  const tracker = new ConfirmedObservationTracker();
  confirmUnnamedAgents([unnamedPane('w1:p1', 'session-1')], tracker);

  for (let sweep = 0; sweep < 3; sweep += 1) {
    const sighting = unnamedPane('w1:p1', 'session-1');
    assert.deepEqual(confirmUnnamedAgents([sighting], tracker), [sighting]);
  }
});
