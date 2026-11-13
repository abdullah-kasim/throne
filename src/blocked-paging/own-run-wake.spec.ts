import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { handlePaneAgentStatusChangedEvent, reconcileBlockedAgentPages } from './blocked-agent-paging.hosted-worker.ts';
import { OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS } from './own-run-wake.ts';
import { harnessProcessHost } from '../process-inspection/harness-background-work-test-fixtures.ts';
import {
  BLOCKED_AT,
  CHILD,
  HARNESS_LINES,
  LONG_SLEEP,
  MINUTE,
  SHADOW,
  SHORT_SLEEP,
  WORKTREE,
  waitingShadow,
} from './own-run-wake-test-fixtures.ts';
import { MessageQueueWorkItemState } from '../message-queue/message-queue-work-item-state.ts';
import { NOT_SENT_FAILURE_PREFIX } from '../throne-work/message-delivery-retry-policy.ts';
import { openMessageQueueStore } from '../message-queue/message-queue.store.ts';
import { deliverMessageWorkItem } from '../throne-work/message-delivery-handler.ts';

test('an agent waiting on its own run is woken once when a process it waited on ends', async () => {
  const shadow = waitingShadow();

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 1, JSON.stringify(shadow.pages));
  assert.match(shadow.wakes()[0]!, /^Ended: sleep 20\.$/m);
  assert.match(shadow.wakes()[0]!, /^Still running: nohup sleep 600 \(running 2m\)\.$/m);
  assert.match(
    shadow.wakes()[0]!,
    /If your run has finished, read its result and continue\. If you are still waiting, first check what is holding the run up, then run `throne my-state waiting-on-own-run "<what>"` and publish the marker again\. If a run has gone on far longer than it should, it is stuck: find out what is holding it up and fix that cause; do not just start it again\./,
  );
});

test('a wake naming an ended run tells the agent its wait is over before it lists what is still running', async () => {
  const shadow = waitingShadow();

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);

  const lines = shadow.wakes()[0]!.split('\n');
  assert.deepEqual(lines.slice(1, 4), [
    'Ended: sleep 20.',
    'If the run you were waiting for is listed as ended, your wait is over: read its result, continue, and end your reply without the marker line, even if something is still running, and ignore the later instruction to publish the marker again. Stop or ignore anything still running that you are not waiting on.',
    'Still running: nohup sleep 600 (running 2m).',
  ]);
});

test('an agent still waiting on its own run is woken every fifteen minutes', async () => {
  const shadow = waitingShadow();
  shadow.state.processLines = [LONG_SLEEP];

  await reconcileBlockedAgentPages(shadow.dependencies);
  assert.equal(shadow.wakes().length, 0);
  shadow.clock.now = BLOCKED_AT + OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS;
  await reconcileBlockedAgentPages(shadow.dependencies);
  await reconcileBlockedAgentPages(shadow.dependencies);
  assert.equal(shadow.wakes().length, 1);
  shadow.clock.now += OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 2);
  assert.match(shadow.wakes()[1]!, /^Still running: nohup sleep 600 \(running 30m\)\.$/m);
  assert.doesNotMatch(shadow.wakes()[1]!, /Ended:/);
});

test('a waiting agent is not woken while its pane is working', async () => {
  const shadow = waitingShadow({ herdrStatus: 'working' });

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now = BLOCKED_AT + 2 * OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.deepEqual(shadow.wakes(), []);
});

test('an agent waiting on a child agent is not woken by the own-run wake', async () => {
  const shadow = waitingShadow({ declared: { state: 'blocked', blockedBy: [CHILD], declaredAt: new Date(BLOCKED_AT).toISOString() } });

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now = BLOCKED_AT + 2 * OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.deepEqual(shadow.wakes(), []);
});

test('an agent whose state file went back to working is not woken', async () => {
  const shadow = waitingShadow();

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.declareState(SHADOW, { state: 'working', declaredAt: new Date(shadow.clock.now).toISOString() });
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now = BLOCKED_AT + 2 * OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.deepEqual(shadow.wakes(), []);
});

test('the regent is not told when a waiting agent is woken', async () => {
  const shadow = waitingShadow();

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 1);
  assert.deepEqual(shadow.recipients, [SHADOW]);
});

test('a reused process id with a different start time counts as the old process having ended', async () => {
  const shadow = waitingShadow();

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = ['60001 52785 60001 Fri Nov 13 06:11:00 2026 sleep 20', LONG_SLEEP];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 1);
  assert.match(shadow.wakes()[0]!, /^Ended: sleep 20\.$/m);
  assert.match(shadow.wakes()[0]!, /^Still running: sleep 20 \(running 1m\); nohup sleep 600 \(running 2m\)\.$/m);
});

test('an agent whose wake message failed to deliver is woken again on the next pass', async () => {
  const shadow = waitingShadow();

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  for (const key of shadow.deliveryOutcomes.keys()) {
    shadow.deliveryOutcomes.set(key, { state: MessageQueueWorkItemState.Failed, failureReason: `${NOT_SENT_FAILURE_PREFIX} after 3 attempts` });
  }
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 2, JSON.stringify(shadow.pages));
  assert.match(shadow.wakes()[1]!, /^Ended: sleep 20\.$/m);
});

async function failureReasonOfADeliveryToAnUnresolvableRecipient(): Promise<string | null> {
  const directory = await mkdtemp(path.join(homedir(), 'tmp', 'own-run-wake-queue-'));
  const store = openMessageQueueStore(path.join(directory, 'queue.sqlite3'));
  try {
    const queued = store.insertWorkItem({
      kind: 'delivery',
      payload: { recipientName: SHADOW, senderName: 'throne', prompt: 'wake' },
      maximumAttempts: 3,
    });
    const claimed = store.claimDueWorkItem(queued.id);
    assert.ok(claimed);
    const finished = await deliverMessageWorkItem(store, claimed, {
      resolveAgent: async () => {
        throw new Error(`no live agent named ${SHADOW}`);
      },
      submitToAgent: async () => assert.fail('nothing may be typed to an agent that could not be addressed'),
      clearBlockedState: async () => undefined,
      readAgentRole: async () => ({ status: 'field-absent' }),
      readAgentSupervisor: async () => ({ status: 'field-absent' }),
      recordDeliveredEvent: async () => null,
      sleep: async () => undefined,
      maxNotSentAttempts: 3,
    });
    assert.equal(finished.state, MessageQueueWorkItemState.Failed);
    return finished.failureReason;
  } finally {
    store.close?.();
    await rm(directory, { recursive: true, force: true });
  }
}

test('an agent whose wake could not be addressed is woken again on the next pass', async () => {
  const shadow = waitingShadow();
  const failureReason = await failureReasonOfADeliveryToAnUnresolvableRecipient();

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  for (const key of shadow.deliveryOutcomes.keys()) {
    shadow.deliveryOutcomes.set(key, { state: MessageQueueWorkItemState.Failed, failureReason });
  }
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 2, JSON.stringify(shadow.pages));
  assert.match(shadow.wakes()[1]!, /^Ended: sleep 20\.$/m);
});

test('an agent is not woken again while its wake message is still waiting to be delivered', async () => {
  const shadow = waitingShadow();

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  for (const key of shadow.deliveryOutcomes.keys()) {
    shadow.deliveryOutcomes.set(key, { state: MessageQueueWorkItemState.Queued, failureReason: null });
  }
  shadow.clock.now = BLOCKED_AT + OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 1, JSON.stringify(shadow.pages));
});

test('an agent whose wake message may already sit in its composer is not woken again with the same news', async () => {
  const shadow = waitingShadow();

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  for (const key of shadow.deliveryOutcomes.keys()) {
    shadow.deliveryOutcomes.set(key, { state: MessageQueueWorkItemState.Failed, failureReason: 'assumed filled, never retried: unreadable submit' });
  }
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 1, JSON.stringify(shadow.pages));
});

test('a run that ends before the next pass still wakes the agent because the turn ending remembers it', async () => {
  const shadow = waitingShadow();

  await handlePaneAgentStatusChangedEvent(
    { paneId: 'w1:p3', workspaceId: '', agentStatus: 'idle', agent: '', displayAgent: '', title: null, stateLabels: {} },
    shadow.dependencies,
    new Set(),
  );
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 1, JSON.stringify(shadow.pages));
  assert.match(shadow.wakes()[0]!, /^Ended: sleep 20\.$/m);
});

test('a run that ends while a slow roster read is still running is remembered as it was when the turn ended', async () => {
  const shadow = waitingShadow();
  const getRoster = shadow.dependencies.getRoster;
  Object.assign(shadow.dependencies, {
    getRoster: async (dataDir: string) => {
      shadow.state.processLines = [LONG_SLEEP];
      return getRoster(dataDir);
    },
  });

  await handlePaneAgentStatusChangedEvent(
    { paneId: 'w1:p3', workspaceId: '', agentStatus: 'idle', agent: '', displayAgent: '', title: null, stateLabels: {} },
    shadow.dependencies,
    new Set(),
  );
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 1, JSON.stringify(shadow.pages));
  assert.match(shadow.wakes()[0]!, /^Ended: sleep 20\.$/m);
});
