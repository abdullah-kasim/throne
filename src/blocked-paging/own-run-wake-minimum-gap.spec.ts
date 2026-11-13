import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reconcileBlockedAgentPages } from './blocked-agent-paging.hosted-worker.ts';
import { OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS, OWN_RUN_WAKE_MINIMUM_GAP_MS } from './own-run-wake.ts';
import {
  BLOCKED_AT,
  LONG_SLEEP,
  MINUTE,
  SECOND_SLEEP,
  SHADOW,
  SHORT_SLEEP,
  TEN_SECONDS,
  THIRD_SLEEP,
  WAITING_ON_OWN_RUN,
  waitingShadow,
} from './own-run-wake-test-fixtures.ts';
import { MessageQueueWorkItemState } from '../message-queue/message-queue-work-item-state.ts';
import { NOT_SENT_FAILURE_PREFIX } from '../throne-work/message-delivery-retry-policy.ts';

test('three runs ending ten seconds apart wake the agent once, then once more five minutes later listing the other two', async () => {
  const shadow = waitingShadow();
  shadow.state.processLines = [SHORT_SLEEP, SECOND_SLEEP, THIRD_SLEEP, LONG_SLEEP];

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [SECOND_SLEEP, THIRD_SLEEP, LONG_SLEEP];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  const firstWokenAt = shadow.clock.now;
  shadow.state.processLines = [THIRD_SLEEP, LONG_SLEEP];
  shadow.clock.now += TEN_SECONDS;
  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now += TEN_SECONDS;
  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.clock.now = firstWokenAt + OWN_RUN_WAKE_MINIMUM_GAP_MS - 1;
  await reconcileBlockedAgentPages(shadow.dependencies);
  assert.equal(shadow.wakes().length, 1, JSON.stringify(shadow.pages));
  shadow.clock.now = firstWokenAt + OWN_RUN_WAKE_MINIMUM_GAP_MS;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 2, JSON.stringify(shadow.pages));
  assert.match(shadow.wakes()[0]!, /^Ended: sleep 20\.$/m);
  assert.match(shadow.wakes()[1]!, /^Ended: sleep 30; sleep 40\.$/m);
});

test('an agent whose runs stop ending gets no extra wake inside fifteen minutes', async () => {
  const shadow = waitingShadow();

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.clock.now += OWN_RUN_WAKE_MINIMUM_GAP_MS;
  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.clock.now += OWN_RUN_WAKE_MINIMUM_GAP_MS;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 1, JSON.stringify(shadow.pages));
});

test('the fifteen minute wake still comes five minutes after a wake for an ended run', async () => {
  const shadow = waitingShadow();

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now = BLOCKED_AT + OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS - 2 * MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [];
  shadow.clock.now = BLOCKED_AT + OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS - MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  assert.equal(shadow.wakes().length, 1, JSON.stringify(shadow.pages));
  shadow.clock.now = BLOCKED_AT + OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS - 2 * MINUTE + OWN_RUN_WAKE_MINIMUM_GAP_MS;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 2, JSON.stringify(shadow.pages));
  assert.match(shadow.wakes()[1]!, /^Ended: nohup sleep 600\.$/m);
});

test('a wake that never reached the pane does not hold back the next wake for five minutes', async () => {
  const shadow = waitingShadow();
  shadow.state.processLines = [SHORT_SLEEP, SECOND_SLEEP, LONG_SLEEP];

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [SECOND_SLEEP, LONG_SLEEP];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  for (const key of shadow.deliveryOutcomes.keys()) {
    shadow.deliveryOutcomes.set(key, { state: MessageQueueWorkItemState.Failed, failureReason: `${NOT_SENT_FAILURE_PREFIX} after 3 attempts` });
  }
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now += TEN_SECONDS;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 2, JSON.stringify(shadow.pages));
  assert.match(shadow.wakes()[1]!, /^Ended: sleep 30; sleep 20\.$/m);
});

test('a backend restart between two ended runs does not wake the agent early', async () => {
  const before = waitingShadow();
  before.state.processLines = [SHORT_SLEEP, SECOND_SLEEP, LONG_SLEEP];

  await reconcileBlockedAgentPages(before.dependencies);
  before.state.processLines = [SECOND_SLEEP, LONG_SLEEP];
  before.clock.now += MINUTE;
  await reconcileBlockedAgentPages(before.dependencies);
  const firstWokenAt = before.clock.now;
  for (const key of before.deliveryOutcomes.keys()) {
    before.deliveryOutcomes.set(key, { state: MessageQueueWorkItemState.Delivered, failureReason: null });
  }
  const saved = JSON.parse(JSON.stringify(await before.dependencies.readRememberedOwnRunWait(SHADOW)));

  const after = waitingShadow();
  await after.dependencies.writeRememberedOwnRunWait(SHADOW, saved);
  for (const [key, outcome] of before.deliveryOutcomes) after.deliveryOutcomes.set(key, outcome);
  after.state.processLines = [LONG_SLEEP];
  after.clock.now = firstWokenAt + TEN_SECONDS;
  await reconcileBlockedAgentPages(after.dependencies);
  assert.equal(after.wakes().length, 0, JSON.stringify(after.pages));
  after.clock.now = firstWokenAt + OWN_RUN_WAKE_MINIMUM_GAP_MS;
  await reconcileBlockedAgentPages(after.dependencies);

  assert.equal(after.wakes().length, 1, JSON.stringify(after.pages));
  assert.match(after.wakes()[0]!, /^Ended: sleep 30\.$/m);
});

test('a new own-run wait is woken at once even within five minutes of the last wake', async () => {
  const shadow = waitingShadow();

  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now += MINUTE;
  await reconcileBlockedAgentPages(shadow.dependencies);
  for (const key of shadow.deliveryOutcomes.keys()) {
    shadow.deliveryOutcomes.set(key, { state: MessageQueueWorkItemState.Delivered, failureReason: null });
  }
  shadow.declareState(SHADOW, { ...WAITING_ON_OWN_RUN, declaredAt: new Date(shadow.clock.now).toISOString() });
  shadow.state.processLines = [SHORT_SLEEP, LONG_SLEEP];
  await reconcileBlockedAgentPages(shadow.dependencies);
  shadow.state.processLines = [LONG_SLEEP];
  shadow.clock.now += TEN_SECONDS;
  await reconcileBlockedAgentPages(shadow.dependencies);

  assert.equal(shadow.wakes().length, 2, JSON.stringify(shadow.pages));
  assert.match(shadow.wakes()[1]!, /^Ended: sleep 20\.$/m);
});
