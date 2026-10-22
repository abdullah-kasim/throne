import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  MessageQueueWorkItemState,
  openMessageQueueStore,
  type MessageQueueStore,
} from '../message-queue/message-queue.store.ts';
import {
  MESSAGE_DELIVERY_WORK_ITEM_KIND,
  type MessageDeliveryWorkItemPayload,
} from '../send-agent/message-delivery-enqueue.ts';
import {
  submitUnattributedToAgentViaQueue,
  type EnqueueHeartbeatMessageDeps,
} from '../throne-work/enqueue-heartbeat-message.ts';
import {
  deliverMessageWorkItem,
  type MessageDeliveryHandlerDeps,
} from '../throne-work/message-delivery-handler.ts';
import { submittedPayload } from '../herdr/herdr-send.helpers.ts';
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import { REAL_NO_IDLING_DEPENDENCIES } from './no-idling.command.ts';
import { NO_IDLING_SENDER } from './no-idling-sender.ts';
import { notifyRegentOfStaleTabs } from './notify-stale-tabs.ts';
import { deps as noIdlingDeps, fakeAgent } from './no-idling-command-test-fixtures.ts';
import { REAL_BLOCKED_AGENT_PAGING_DEPENDENCIES } from '../blocked-paging/blocked-agent-paging.hosted-worker.ts';
import {
  BLOCKED_AGENT_PAGING_SENDER,
  submitPageToRegent,
} from '../blocked-paging/blocked-agent-regent-page.ts';

const STALE_TAB_REPORT = {
  label: 'shadow-gone-01',
  tabId: 'tab-gone',
  paneCount: 1,
  reason: 'label exactly matches a throne ledger agent name (shadow-gone-01)',
};

const BLOCKED_PAGE_TEXT = 'alpha-stuck-01 is blocked on shadow-gone-01, which no longer exists.';

const QUIET_ENQUEUE_DEPS: EnqueueHeartbeatMessageDeps = {
  now: () => 0,
  writeStderr: () => undefined,
  checkSustainedOutage: async () => undefined,
};

interface QueueScene {
  readonly store: MessageQueueStore;
  readonly submitToAgent: (
    target: HerdrAgent,
    senderName: string,
    prompt: string,
    options?: Parameters<typeof submitUnattributedToAgentViaQueue>[3],
  ) => Promise<void>;
}

async function withQueueScene(run: (scene: QueueScene) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'throne-sweep-sender-'));
  const databasePath = path.join(directory, 'queue.sqlite3');
  const store = openMessageQueueStore(databasePath);
  try {
    await run({
      store,
      submitToAgent: (target, senderName, prompt, options) =>
        submitUnattributedToAgentViaQueue(target, senderName, prompt, options, QUIET_ENQUEUE_DEPS, () =>
          openMessageQueueStore(databasePath),
        ),
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function onlyQueuedPayload(store: MessageQueueStore): MessageDeliveryWorkItemPayload {
  const queued = store.listWorkItemsByStates([MessageQueueWorkItemState.Queued]).filter((item) => item.kind === MESSAGE_DELIVERY_WORK_ITEM_KIND);
  assert.equal(queued.length, 1);
  return queued[0].payload as MessageDeliveryWorkItemPayload;
}

async function deliverOnlyQueuedMessage(store: MessageQueueStore): Promise<{ typedText: string; messageId: number }> {
  const claimed = store.claimNextDueWorkItem([MESSAGE_DELIVERY_WORK_ITEM_KIND]);
  assert.ok(claimed);
  let typedText = '';
  const handlerDeps: MessageDeliveryHandlerDeps = {
    resolveAgent: async (name) => fakeAgent(name, 'idle'),
    submitToAgent: async (_agent, senderName, prompt, options) => {
      typedText = submittedPayload(senderName, prompt, options);
      return typedText;
    },
    recordDeliveredEvent: async () => null,
    readAgentRole: async () => ({ status: 'field-absent' }),
    readAgentSupervisor: async () => ({ status: 'field-absent' }),
    clearBlockedMarker: async () => undefined,
    sleep: async () => undefined,
    maxNotSentAttempts: 1,
  };
  const delivered = await deliverMessageWorkItem(store, claimed, handlerDeps);
  assert.equal(delivered.state, MessageQueueWorkItemState.Delivered);
  return { typedText, messageId: claimed.id };
}

function textTypedWithoutASender(prompt: string, messageId: number): string {
  return submittedPayload('', prompt, { messageId });
}

test('no-idling messages are queued with the no-idling sweep as their sender', async () => {
  assert.equal(REAL_NO_IDLING_DEPENDENCIES.submitToAgent, submitUnattributedToAgentViaQueue);
  await withQueueScene(async (scene) => {
    const { dependencies } = noIdlingDeps({
      detectStaleTabs: async () => [STALE_TAB_REPORT],
      submitToAgent: scene.submitToAgent,
    });
    await notifyRegentOfStaleTabs(dependencies, '/data');
    assert.equal(onlyQueuedPayload(scene.store).senderName, NO_IDLING_SENDER);
    assert.equal(NO_IDLING_SENDER, 'no-idling');
  });
});

test('blocked-agent pages are queued with the paging sweep as their sender', async () => {
  assert.equal(REAL_BLOCKED_AGENT_PAGING_DEPENDENCIES.submitToAgent, submitUnattributedToAgentViaQueue);
  await withQueueScene(async (scene) => {
    await submitPageToRegent(BLOCKED_PAGE_TEXT, 'page-key', {
      resolveAgent: async (name) => fakeAgent(name, 'idle'),
      submitToAgent: scene.submitToAgent,
    });
    assert.equal(onlyQueuedPayload(scene.store).senderName, BLOCKED_AGENT_PAGING_SENDER);
    assert.equal(BLOCKED_AGENT_PAGING_SENDER, 'blocked-paging');
  });
});

test('naming a sweep does not change the text it types into an agent\'s pane', async () => {
  await withQueueScene(async (scene) => {
    const { dependencies } = noIdlingDeps({
      detectStaleTabs: async () => [STALE_TAB_REPORT],
      submitToAgent: scene.submitToAgent,
    });
    await notifyRegentOfStaleTabs(dependencies, '/data');
    const noIdlingPrompt = onlyQueuedPayload(scene.store).prompt;
    const noIdlingDelivery = await deliverOnlyQueuedMessage(scene.store);
    assert.equal(noIdlingDelivery.typedText, textTypedWithoutASender(noIdlingPrompt, noIdlingDelivery.messageId));
  });
  await withQueueScene(async (scene) => {
    await submitPageToRegent(BLOCKED_PAGE_TEXT, 'page-key', {
      resolveAgent: async (name) => fakeAgent(name, 'idle'),
      submitToAgent: scene.submitToAgent,
    });
    const pageDelivery = await deliverOnlyQueuedMessage(scene.store);
    assert.equal(pageDelivery.typedText, textTypedWithoutASender(BLOCKED_PAGE_TEXT, pageDelivery.messageId));
  });
});
