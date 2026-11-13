import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SendAgentCommand } from './send-agent.command.ts';
import { captureRun, fakeQueueStore } from './send-agent-command-test-fixtures.ts';
import type { SendAgentCommandDependencies } from './send-agent-dependencies.types.ts';
import { ForcedEnterRefusedError } from '../herdr/forced-enter.ts';

function command(forceEnter: (recipient: { paneId?: string }) => Promise<void>) {
  const store = fakeQueueStore(Date.now());
  const sent: string[] = [];
  const dependencies: SendAgentCommandDependencies = {
    resolveAgent: async (name) => ({ name, paneId: 'w1:p1' }),
    resolveCurrentAgentName: async () => 'alpha-sender',
    submitToAgent: async (_recipient, _sender, prompt) => {
      sent.push(prompt);
    },
    openMessageQueueStore: () => store as never,
    forceEnter: forceEnter as never,
  };
  return { store, sent, run: new SendAgentCommand(dependencies) };
}

describe('send-agent --enter-only', () => {
  it('presses Enter in the caller process without enqueueing, prints one line and exits 0', async () => {
    const pressed: string[] = [];
    const { store, sent, run } = command(async (recipient) => {
      pressed.push(recipient.paneId ?? '');
    });
    const result = await captureRun(['shadow-stuck', '--enter-only'], run);
    assert.equal(result.status, 0);
    assert.deepEqual(pressed, ['w1:p1']);
    assert.deepEqual(store.inserted, []);
    assert.deepEqual(sent, []);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.match(result.stdout, /pressed Enter/);
  });

  it('presses the same way with --direct', async () => {
    const pressed: string[] = [];
    const { store, run } = command(async (recipient) => {
      pressed.push(recipient.paneId ?? '');
    });
    const result = await captureRun(['shadow-stuck', '--enter-only', '--direct'], run);
    assert.equal(result.status, 0);
    assert.deepEqual(pressed, ['w1:p1']);
    assert.deepEqual(store.inserted, []);
  });

  it('prints the refusal and exits non-zero when a dialog covers the box', async () => {
    const { store, run } = command(async () => {
      throw new ForcedEnterRefusedError("a dialog covers shadow-stuck's input box; pressed nothing");
    });
    const result = await captureRun(['shadow-stuck', '--enter-only'], run);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dialog/);
    assert.deepEqual(store.inserted, []);
  });

  it('refuses message text alongside --enter-only', async () => {
    const pressed: string[] = [];
    const { run } = command(async () => {
      pressed.push('x');
    });
    const result = await captureRun(['shadow-stuck', '--enter-only', 'hello'], run);
    assert.equal(result.status, 1);
    assert.deepEqual(pressed, []);
  });
});
