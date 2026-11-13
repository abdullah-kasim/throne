import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runNoIdling } from './no-idling-run.ts';
import type { AgentState } from '../agentdata/agent-state.service.ts';
import { declaredState, deps, identityFound, rosterEntry } from './no-idling-command-test-fixtures.ts';

test('an Alpha whose state file names its child is woken once that child is reapable, and not before', async () => {
  const states = new Map<string, AgentState>([
    ['alpha-bakery-01', declaredState('blocked', { blockedBy: ['shadow-bakery-02-photos'] })],
  ]);
  let childStatus: 'idle' | 'working' = 'working';
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [
      rosterEntry('alpha-bakery-01', 'Alpha', 'idle'),
      rosterEntry('shadow-bakery-02-photos', 'Shadow', childStatus),
    ],
    readAgentSupervisor: async (name) =>
      name === 'shadow-bakery-02-photos' ? identityFound('alpha-bakery-01') : identityFound('Regent'),
    readAgentState: async (name) => states.get(name) ?? declaredState('working', { declaredBy: 'turn-start' }),
    markAgentWorking: async (name) => {
      states.set(name, declaredState('working'));
    },
    isRegisteredAgent: async () => true,
    stillBlockedObservations: new Map<string, number>(),
  });

  await runNoIdling(dependencies, { notify: true });
  assert.deepEqual(
    submitCalls.filter((call) => call.target.name === 'alpha-bakery-01'),
    [],
    'no wake while the named child is still working',
  );
  assert.equal(states.get('alpha-bakery-01')?.state, 'blocked');

  states.set('shadow-bakery-02-photos', declaredState('reapable', { reapableReason: 'completed' }));
  childStatus = 'idle';
  await runNoIdling(dependencies, { notify: true });

  const wakes = submitCalls.filter((call) => call.target.name === 'alpha-bakery-01');
  assert.equal(wakes.length, 1, `expected one wake, got ${JSON.stringify(wakes.map((call) => call.prompt))}`);
  assert.match(wakes[0]!.prompt, /shadow-bakery-02-photos/);
  assert.equal(states.get('alpha-bakery-01')?.state, 'working', 'the wake records the woken Alpha as working');
});

test('the no idling sweep never reads the state of the Regent or a Stager', async () => {  const { ACCEPTANCE_DATA } = await import('../agentdata/acceptance-data.service.ts');
  const { THRONE_DATA_DIR } = await import('../shared-policy/throne-home.ts');
  const { rm } = await import('node:fs/promises');
  const pathModule = await import('node:path');
  const court = [
    rosterEntry('regent', 'Regent', 'idle'),
    rosterEntry('stager-harbour-proof', 'Stager', 'idle'),
    rosterEntry('alpha-harbour-proof', 'Alpha', 'idle'),
    rosterEntry('shadow-harbour-proof', 'Shadow', 'idle'),
  ];
  const proofAgents = court.slice(1);
  const reads: string[] = [];
  try {
    for (const entry of proofAgents) {
      await ACCEPTANCE_DATA.write(entry.name, { acceptedAt: '2026-11-13T00:00:00.000Z', by: 'regent', how: 'merge' }, THRONE_DATA_DIR);
    }
    const { dependencies } = deps({
      getRoster: async () => [...court],
      readAgentState: async (name) => {
        reads.push(name);
        return declaredState('working', { declaredBy: 'turn-start' });
      },
    });
    await runNoIdling(dependencies, { notify: false });
  } finally {
    for (const entry of proofAgents) {
      await rm(pathModule.join(THRONE_DATA_DIR, entry.name), { recursive: true, force: true });
    }
  }
  assert.deepEqual([...new Set(reads)].sort(), ['alpha-harbour-proof', 'shadow-harbour-proof']);
});
