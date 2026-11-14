import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { reconcileBlockedAgentPages } from './blocked-agent-paging.hosted-worker.ts';
import { OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS } from './own-run-wake.ts';
import { HARNESS_BACKGROUND_WORK_KINDS } from '../process-inspection/harness-background-work.ts';
import {
  BLOCKED_AT,
  CHILD,
  HARNESS_LINES,
  LONG_SLEEP,
  MINUTE,
  SHADOW,
  WAITING_ON_OWN_RUN,
  WORKTREE,
  waitingShadow,
} from './own-run-wake-test-fixtures.ts';
import { MessageQueueWorkItemState } from '../message-queue/message-queue-work-item-state.ts';
import { NOT_SENT_FAILURE_PREFIX } from '../throne-work/message-delivery-retry-policy.ts';
import { openMessageQueueStore } from '../message-queue/message-queue.store.ts';
import { deliverMessageWorkItem } from '../throne-work/message-delivery-handler.ts';

test('a hundred child processes ending one by one while the run continues give only the timed reminders', async () => {
  const shadow = waitingShadow();
  const helpers = Array.from({ length: 100 }, (_, index) => `${61000 + index} 52785 ${61000 + index} Fri Nov 13 06:10:00 2026 sleep 5`);
  shadow.state.processLines = [...helpers, LONG_SLEEP];

  await reconcileBlockedAgentPages(shadow.dependencies);
  for (let ended = 1; ended <= 100; ended += 1) {
    shadow.state.processLines = [...helpers.slice(ended), LONG_SLEEP];
    shadow.clock.now = BLOCKED_AT + MINUTE + ended * 10_000;
    await reconcileBlockedAgentPages(shadow.dependencies);
  }

  assert.equal(shadow.wakes().length, 1, JSON.stringify(shadow.pages));
  assert.match(shadow.wakes()[0]!, /nohup sleep 600 \(running 15m\)\.$/m);
  assert.doesNotMatch(shadow.wakes()[0]!, /Ended:/);
});

test('the agent is woken once when nothing it started is still running', async () => {
  const shadow = waitingShadow();

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  assert.equal(shadow.wakes().length, 0);
  shadow.state.processLines = [];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 1, JSON.stringify(shadow.pages));
  assert.match(shadow.wakes()[0]!, /^Nothing is still running\.$/m);
});

test('an agent with nothing running is not woken again for the same declaration before its reminder', async () => {
  const shadow = waitingShadow();
  shadow.state.processLines = [];

  for (let minute = 1; minute < 15; minute += 1) {
    shadow.clock.now = BLOCKED_AT + minute * MINUTE;
    await reconcileBlockedAgentPages(shadow.dependencies);
  }
  assert.equal(shadow.wakes().length, 1, JSON.stringify(shadow.pages));
  shadow.clock.now = BLOCKED_AT + OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 2, JSON.stringify(shadow.pages));
});

test('the reminder comes every 15 minutes when no interval was asked for', async () => {
  const shadow = waitingShadow();
  shadow.state.processLines = [LONG_SLEEP];

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.clock.now = BLOCKED_AT + OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS - 1;
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
});

test('the reminder uses the interval the agent asked for', async () => {
  const shadow = waitingShadow({ declared: { ...WAITING_ON_OWN_RUN, remindInMinutes: 30 } });
  shadow.state.processLines = [LONG_SLEEP];

  shadow.clock.now = BLOCKED_AT + 30 * MINUTE - 1;
  await reconcileBlockedAgentPages(shadow.dependencies);
  assert.equal(shadow.wakes().length, 0);
  shadow.clock.now = BLOCKED_AT + 30 * MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.clock.now = BLOCKED_AT + 60 * MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 2, JSON.stringify(shadow.pages));
});

test('a new declaration restarts the reminder count from its own time', async () => {
  const shadow = waitingShadow({ declared: { ...WAITING_ON_OWN_RUN, remindInMinutes: 30 } });
  shadow.state.processLines = [LONG_SLEEP];

  shadow.clock.now = BLOCKED_AT + 20 * MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  const redeclaredAt = shadow.clock.now;
  shadow.declareState(SHADOW, { ...WAITING_ON_OWN_RUN, declaredAt: new Date(redeclaredAt).toISOString() });
  shadow.clock.now = redeclaredAt + OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS - 1;
  await reconcileBlockedAgentPages(shadow.dependencies);
  assert.equal(shadow.wakes().length, 0);
  shadow.clock.now = redeclaredAt + OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 1, JSON.stringify(shadow.pages));
});

test('a new declaration with nothing running is woken once again', async () => {
  const shadow = waitingShadow();
  shadow.state.processLines = [];

  await reconcileBlockedAgentPages(shadow.dependencies);
  for (const key of shadow.deliveryOutcomes.keys()) {
    shadow.deliveryOutcomes.set(key, { state: MessageQueueWorkItemState.Delivered, failureReason: null });
  }
  shadow.declareState(SHADOW, { ...WAITING_ON_OWN_RUN, declaredAt: new Date(shadow.clock.now).toISOString() });
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 2, JSON.stringify(shadow.pages));
});

test('an unknown background state never counts as nothing running', async () => {
  const shadow = waitingShadow();
  Object.assign(shadow.dependencies, { readHarnessBackgroundWork: async () => ({ kind: HARNESS_BACKGROUND_WORK_KINDS.UNKNOWN }) });

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.deepEqual(shadow.wakes(), []);
});

test('the wake message tells the agent it may ask for a longer wait', async () => {
  const shadow = waitingShadow();
  shadow.state.processLines = [];

  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.deepEqual(shadow.wakes()[0]!.split('\n'), [
    'You are waiting on your own background run.',
    'Nothing is still running.',
    'If your run has finished, read its result and continue. If you are still waiting, first check what is holding the run up, then run `throne my-state waiting-on-own-run "<what>"` and publish the marker again.',
    'When you declare again you may ask for a longer wait with `--remind-in <minutes>` (5 to 60); if you ask for none, the next reminder comes within 15 minutes.',
    'If a run has gone on far longer than it should, it is stuck: find out what is holding it up and fix that cause; do not just start it again.',
  ]);
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
  shadow.clock.now = BLOCKED_AT + OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 1);
  assert.deepEqual(shadow.recipients, [SHADOW]);
});

test('an agent whose wake message failed to deliver is woken again on the next pass', async () => {
  const shadow = waitingShadow();

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  for (const key of shadow.deliveryOutcomes.keys()) {
    shadow.deliveryOutcomes.set(key, { state: MessageQueueWorkItemState.Failed, failureReason: `${NOT_SENT_FAILURE_PREFIX} after 3 attempts` });
  }
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 2, JSON.stringify(shadow.pages));
  assert.match(shadow.wakes()[1]!, /^Nothing is still running\.$/m);
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
  shadow.state.processLines = [];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  for (const key of shadow.deliveryOutcomes.keys()) {
    shadow.deliveryOutcomes.set(key, { state: MessageQueueWorkItemState.Failed, failureReason });
  }
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 2, JSON.stringify(shadow.pages));
  assert.match(shadow.wakes()[1]!, /^Nothing is still running\.$/m);
});

test('an agent is not woken again while its wake message is still waiting to be delivered', async () => {
  const shadow = waitingShadow();

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [];
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
  shadow.state.processLines = [];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  for (const key of shadow.deliveryOutcomes.keys()) {
    shadow.deliveryOutcomes.set(key, { state: MessageQueueWorkItemState.Failed, failureReason: 'assumed filled, never retried: unreadable submit' });
  }
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 1, JSON.stringify(shadow.pages));
});

