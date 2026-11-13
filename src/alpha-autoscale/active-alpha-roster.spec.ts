import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentState, AgentStateName } from '../agentdata/agent-state.service.ts';
import { AGENT_LIFECYCLE_STATES } from '../agent-statuses/agent-statuses.types.ts';
import { readActiveAlphaCapacityInputs } from './active-alpha-roster.ts';

const OBSERVED_AT = new Date('2026-11-14T12:00:00.000Z');
const DECLARED_AT = '2026-11-14T11:00:00.000Z';

function declared(state: AgentStateName): AgentState {
  return { state, blockedBy: [], waitingOn: null, reapableReason: null, declaredAt: DECLARED_AT, declaredBy: 'agent' };
}

async function capacityOf(states: Record<string, AgentStateName>) {
  return readActiveAlphaCapacityInputs({
    getRoster: async () =>
      Object.keys(states).map((name) => ({
        name,
        role: 'Alpha',
        lifecycle: AGENT_LIFECYCLE_STATES.LIVE,
        liveStatus: 'idle' as const,
        reportLanded: false,
        focused: false,
      })),
    readAgentState: async (name) => declared(states[name]!),
    now: () => OBSERVED_AT,
  });
}

test('an Alpha whose state file says blocked carries blocked evidence dated when it declared it', async () => {
  const { activeRecords } = await capacityOf({ 'alpha-a-01': 'blocked' });
  assert.deepEqual(activeRecords[0]!.blockedEvidence, {
    blockedAt: DECLARED_AT,
    observedAt: OBSERVED_AT.toISOString(),
    liveStatus: 'idle',
  });
});

test('an Alpha whose state file says anything but blocked carries no blocked evidence', async () => {
  const { activeRecords } = await capacityOf({
    'alpha-a-01': 'working',
    'alpha-b-01': 'waiting-on-own-run',
    'alpha-c-01': 'waiting-on-supervisor',
    'alpha-d-01': 'reapable',
  });
  assert.deepEqual(
    activeRecords.map((record) => record.blockedEvidence),
    [undefined, undefined, undefined, undefined],
  );
});
