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
import { deps, identityFound, rosterEntry } from './no-idling-command-test-fixtures.ts';

test('an Alpha blocked on a child whose ledger registration is gone is woken directly with a message naming that child', async () => {
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [
      rosterEntry('alpha-wob', 'Alpha', 'idle'),
      rosterEntry('shadow-wob-01', 'Shadow', 'idle'),
    ],
    readAgentSupervisor: async (name) =>
      name === 'shadow-wob-01' ? identityFound('alpha-wob') : identityFound('Regent'),
    readAgent: async (name) =>
      name === 'alpha-wob'
        ? 'Waiting on shadow-wob-01, then I will merge.\n{"blocked":true} __BLOCKED_BY_shadow-wob-01__'
        : 'still working the slice',
    // Ledger truth says the named child is gone (archived to `.reaped/`)
    // while the roster snapshot above still lists it as live -- the exact
    // stale-roster scenario this mechanism exists to see past.
    isRegisteredAgent: async (name) => name !== 'shadow-wob-01',
  });

  const exitCode = await runNoIdling(dependencies, { notify: true });

  assert.equal(exitCode, 0);
  const wake = submitCalls.find((call) => call.target.name === 'alpha-wob');
  assert.ok(wake, 'the blocked Alpha itself received a message');
  assert.match(wake!.prompt, /shadow-wob-01/);
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
    (call) => call.target.name === 'Regent' && call.prompt.includes('alpha-wob'),
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
      rosterEntry('alpha-wob', 'Alpha', 'idle'),
      rosterEntry('shadow-wob-01', 'Shadow', 'idle'),
      rosterEntry('shadow-wob-02', 'Shadow', 'idle'),
    ],
    readAgentSupervisor: async (name) =>
      ['shadow-wob-01', 'shadow-wob-02'].includes(name)
        ? identityFound('alpha-wob')
        : identityFound('Regent'),
    readAgent: async (name) =>
      name === 'alpha-wob'
        ? '{"blocked":true} __BLOCKED_BY_shadow-wob-01__ __BLOCKED_BY_shadow-wob-02__'
        : 'still working the slice',
    // Only shadow-wob-01 is gone; shadow-wob-02 still resolves.
    isRegisteredAgent: async (name) => name === 'shadow-wob-02',
  });

  const exitCode = await runNoIdling(dependencies, { notify: true });

  assert.equal(exitCode, 0);
  const wake = submitCalls.find((call) => call.target.name === 'alpha-wob');
  assert.equal(wake, undefined, 'a partially-cleared dependency must never wake the agent');
});

test('an Alpha blocked with no named children is left untouched by the dependency-cleared wake', async () => {
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [
      rosterEntry('alpha-wob', 'Alpha', 'idle'),
      rosterEntry('shadow-wob-01', 'Shadow', 'idle'),
    ],
    readAgentSupervisor: async (name) =>
      name === 'shadow-wob-01' ? identityFound('alpha-wob') : identityFound('Regent'),
    readAgent: async (name) => (name === 'alpha-wob' ? '{"blocked":true}' : 'still working the slice'),
    isRegisteredAgent: async () => false,
  });

  const exitCode = await runNoIdling(dependencies, { notify: true });

  assert.equal(exitCode, 0);
  const wake = submitCalls.find((call) => call.target.name === 'alpha-wob');
  assert.equal(wake, undefined, 'no named children means this mechanism must never fire');
});
