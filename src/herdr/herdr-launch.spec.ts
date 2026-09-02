// Requirement: launching a harness into a pane does not get recorded into
// the operator's bash history.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startInTab } from './herdr-launch.ts';
import type { StartInTabDeps, StartOptions } from './herdr-create.contracts.ts';

test('the launch command is typed with a leading space so bash ignorespace history control skips it', async () => {
  const calls: string[][] = [];

  const fakeRunHerdr = (async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'agent' && args[1] === 'list') {
      return {
        stdout: JSON.stringify({
          result: {
            agents: [
              {
                agent: 'claude',
                terminal_id: 'term-1',
                pane_id: 'pane-1',
                name: 'agent-name',
              },
            ],
          },
        }),
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  }) as StartInTabDeps['runHerdr'];

  const deps: StartInTabDeps = {
    runHerdr: fakeRunHerdr,
    now: () => 0,
    sleep: async () => undefined,
  };

  const opts: StartOptions = { argv: ['claude'] };

  try {
    await startInTab('agent-name', 'pane-1', opts, deps);
  } catch {
    // The fake `agent list`/`rename` responses are minimal; only the pane
    // invocation shape under test (send-text vs. run) matters here.
  }

  const sendTextCall = calls.find((c) => c[0] === 'pane' && c[1] === 'send-text');
  assert.ok(sendTextCall, 'the launch was issued via pane send-text, not pane run');
  const typedLine = sendTextCall![3]!;
  assert.ok(
    typedLine.startsWith(' bash '),
    `typed launch line "${typedLine}" must start with a single leading space to suppress history recording`,
  );

  const sendKeysCall = calls.find((c) => c[0] === 'pane' && c[1] === 'send-keys');
  assert.ok(sendKeysCall, 'Enter was sent after the typed launch line');

  const runCall = calls.find((c) => c[0] === 'pane' && c[1] === 'run');
  assert.equal(runCall, undefined, 'pane run must not be used for launching');
});
