// Requirement: an Alpha blocked on a named child that has already been
// reaped is woken directly, with a message naming exactly which children
// cleared -- never paged to the Regent. Companion regression: a still-live
// named child, or no named children at all, leaves the agent untouched.
//
// Per the exact wording, every fixture here makes the named child's ledger
// registration absent DIRECTLY (`isRegisteredAgent` returns false) -- never
// by having the child agent send a completion message through the message
// channel. The roster snapshot deliberately still lists the reaped child as
// live, proving the sweep never consults roster presence for this decision.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runNoIdling } from './no-idling-run.ts';
import { declaredState, deps, identityFound, rosterEntry, stateFiles } from './no-idling-command-test-fixtures.ts';

test('an Alpha blocked on a child whose ledger registration is gone is woken directly with a message naming that child', async () => {
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [
      rosterEntry('alpha-fig', 'Alpha', 'idle'),
      rosterEntry('shadow-fig-01', 'Shadow', 'idle'),
    ],
    readAgentSupervisor: async (name) =>
      name === 'shadow-fig-01' ? identityFound('alpha-fig') : identityFound('Regent'),
    readAgentState: stateFiles({ 'alpha-fig': declaredState('blocked', { blockedBy: ['shadow-fig-01'] }) }),
    // Ledger truth says the named child is gone (archived to `.reaped/`)
    // while the roster snapshot above still lists it as live -- the exact
    // stale-roster scenario this mechanism exists to see past.
    isRegisteredAgent: async (name) => name !== 'shadow-fig-01',
  });

  const exitCode = await runNoIdling(dependencies, { notify: true });

  assert.equal(exitCode, 0);
  const wake = submitCalls.find((call) => call.target.name === 'alpha-fig');
  assert.ok(wake, 'the blocked Alpha itself received a message');
  assert.match(wake!.prompt, /shadow-fig-01/);
  assert.ok(
    !/^Continue\.?$/i.test(wake!.prompt.trim()),
    'the message must name the specific child, not be a generic continue',
  );
  // The wake path never routes through the Regent: no Regent-directed
  // message (idle-family notice or otherwise) may mention the just-woken
  // Alpha. A different, pre-existing mechanism (the reapability protocol)
  // may still page the Regent about the unrelated idle Shadow in this
  // fixture -- that is untouched by this slice and not asserted against
  // here.
  const regentCallsNamingAlpha = submitCalls.filter(
    (call) => call.target.name === 'Regent' && call.prompt.includes('alpha-fig'),
  );
  assert.deepEqual(
    regentCallsNamingAlpha,
    [],
    'the Regent must never be told about this Alpha -- resolving this case must not cost a Regent round-trip',
  );
});

test('an Alpha blocked on two children where only one has cleared is left untouched', async () => {
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [
      rosterEntry('alpha-fig', 'Alpha', 'idle'),
      rosterEntry('shadow-fig-01', 'Shadow', 'idle'),
      rosterEntry('shadow-fig-02', 'Shadow', 'idle'),
    ],
    readAgentSupervisor: async (name) =>
      ['shadow-fig-01', 'shadow-fig-02'].includes(name)
        ? identityFound('alpha-fig')
        : identityFound('Regent'),
    readAgentState: stateFiles({
      'alpha-fig': declaredState('blocked', { blockedBy: ['shadow-fig-01', 'shadow-fig-02'] }),
    }),
    // Only shadow-fig-01 is gone; shadow-fig-02 still resolves.
    isRegisteredAgent: async (name) => name === 'shadow-fig-02',
  });

  const exitCode = await runNoIdling(dependencies, { notify: true });

  assert.equal(exitCode, 0);
  const wake = submitCalls.find((call) => call.target.name === 'alpha-fig');
  assert.equal(wake, undefined, 'a partially-cleared dependency must never wake the agent');
});

test('an Alpha blocked with no named children is left untouched by the dependency-cleared wake', async () => {
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [
      rosterEntry('alpha-fig', 'Alpha', 'idle'),
      rosterEntry('shadow-fig-01', 'Shadow', 'idle'),
    ],
    readAgentSupervisor: async (name) =>
      name === 'shadow-fig-01' ? identityFound('alpha-fig') : identityFound('Regent'),
    readAgentState: stateFiles({ 'alpha-fig': declaredState('blocked') }),
    isRegisteredAgent: async () => false,
  });

  const exitCode = await runNoIdling(dependencies, { notify: true });

  assert.equal(exitCode, 0);
  const wake = submitCalls.find((call) => call.target.name === 'alpha-fig');
  assert.equal(wake, undefined, 'no named children means this mechanism must never fire');
});

test('an Alpha blocked on a child that already declared itself reapable is woken and told to reap it', async () => {
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [
      rosterEntry('alpha-fig', 'Alpha', 'idle'),
      rosterEntry('shadow-fig-99b', 'Shadow', 'idle'),
    ],
    readAgentSupervisor: async (name) =>
      name === 'shadow-fig-99b' ? identityFound('alpha-fig') : identityFound('Regent'),
    readAgentState: stateFiles({
      'alpha-fig': declaredState('blocked', { blockedBy: ['shadow-fig-99b'] }),
      'shadow-fig-99b': declaredState('reapable', { reapableReason: 'completed' }),
    }),
    isRegisteredAgent: async () => true,
  });

  const exitCode = await runNoIdling(dependencies, { notify: true });

  assert.equal(exitCode, 0);
  const wake = submitCalls.find((call) => call.target.name === 'alpha-fig');
  assert.ok(wake, 'the blocked Alpha is woken even though its child is still registered');
  assert.match(wake!.prompt, /shadow-fig-99b already declared itself reapable/);
  assert.match(wake!.prompt, /reap it with reap-agent/);
  const regentCallsNamingAlpha = submitCalls.filter(
    (call) => call.target.name === 'Regent' && call.prompt.includes('alpha-fig'),
  );
  assert.deepEqual(regentCallsNamingAlpha, [], 'one sweep wakes the Alpha without costing the Regent a turn');
});

test('an Alpha blocked on one reapable child and one still-working child is left untouched', async () => {
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [
      rosterEntry('alpha-fig', 'Alpha', 'idle'),
      rosterEntry('shadow-fig-01', 'Shadow', 'idle'),
      rosterEntry('shadow-fig-02', 'Shadow', 'idle'),
    ],
    readAgentSupervisor: async (name) =>
      ['shadow-fig-01', 'shadow-fig-02'].includes(name)
        ? identityFound('alpha-fig')
        : identityFound('Regent'),
    readAgentState: stateFiles({
      'alpha-fig': declaredState('blocked', { blockedBy: ['shadow-fig-01', 'shadow-fig-02'] }),
      'shadow-fig-01': declaredState('reapable', { reapableReason: 'completed' }),
    }),
    isRegisteredAgent: async () => true,
  });

  const exitCode = await runNoIdling(dependencies, { notify: true });

  assert.equal(exitCode, 0);
  assert.equal(
    submitCalls.find((call) => call.target.name === 'alpha-fig'),
    undefined,
    'a child that is still working keeps the block in place',
  );
});

test('an Alpha still blocked on a reapable child on the next sweep is reported to the Regent once', async () => {
  const stillBlockedObservations = new Map<string, number>();
  const sweep = () =>
    deps({
      getRoster: async () => [
        rosterEntry('alpha-fig', 'Alpha', 'idle'),
        rosterEntry('shadow-fig-99b', 'Shadow', 'idle'),
      ],
      readAgentSupervisor: async (name) =>
        name === 'shadow-fig-99b' ? identityFound('alpha-fig') : identityFound('Regent'),
      readAgentState: stateFiles({
        'alpha-fig': declaredState('blocked', { blockedBy: ['shadow-fig-99b'] }),
        'shadow-fig-99b': declaredState('reapable', { reapableReason: 'completed' }),
      }),
      isRegisteredAgent: async () => true,
      stillBlockedObservations,
    });

  const first = sweep();
  await runNoIdling(first.dependencies, { notify: true });
  assert.deepEqual(
    first.submitCalls.filter((call) => call.target.name === 'Regent' && call.prompt.includes('alpha-fig')),
    [],
    'the first sweep only wakes the Alpha',
  );

  const second = sweep();
  await runNoIdling(second.dependencies, { notify: true });
  const notice = second.submitCalls.find(
    (call) => call.target.name === 'Regent' && call.prompt.includes('alpha-fig'),
  );
  assert.ok(notice, 'the second sweep tells the Regent');
  assert.match(notice!.prompt, /Still blocked on children that are already finished/);
  assert.match(notice!.prompt, /shadow-fig-99b already declared itself reapable/);
});

test('an agent blocked on its own background run is never woken as if a child had finished', async () => {
  const stillBlockedObservations = new Map<string, number>();
  const callsNamingTheAgent = [];
  for (let sweep = 0; sweep < 3; sweep += 1) {
    const { dependencies, submitCalls } = deps({
      getRoster: async () => [rosterEntry('alpha-oven', 'Alpha', 'idle')],
      readAgentState: async () => declaredState('waiting-on-own-run', { waitingOn: 'candidate and base suites' }),
      isRegisteredAgent: async () => false,
      stillBlockedObservations,
    });
    await runNoIdling(dependencies, { notify: true });
    callsNamingTheAgent.push(...submitCalls.filter((call) => call.prompt.includes('alpha-oven')));
  }

  assert.deepEqual(callsNamingTheAgent, []);
});
