import assert from "node:assert/strict";
import { test } from "node:test";
import { submittedPayload } from "../src/herdr/herdr-send.helpers.ts";

test("a delivered message is wrapped in an opening and closing tag carrying its number", () => {
  assert.equal(
    submittedPayload("stager-eleventh", "PR 157 is green", { messageId: 3362 }),
    "<message3362>\nstager-eleventh said: PR 157 is green\n</message3362>",
  );
});

test("a message delivered without attribution still carries both tags", () => {
  assert.equal(
    submittedPayload("keep-going", "run render-queue", { omitSenderAttribution: true, messageId: 7 }),
    "<message7>\nrun render-queue\n</message7>",
  );
});

test("a direct send with no queue id carries no tags", () => {
  assert.equal(submittedPayload("sender", "hello", {}), "sender said: hello");
});

import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { HerdrAgent } from "../src/herdr/herdr-inventory.service.ts";
import { openMessageQueueStore } from "../src/message-queue/message-queue.store.ts";
import {
  deliverMessageWorkItem,
  type MessageDeliveryHandlerDeps,
} from "../src/throne-work/message-delivery-handler.ts";

test("the queue handler hands the pane the work item's own id as the message id", async () => {
  const directory = await mkdtemp(path.join(homedir(), "tmp", "throne-message-id-"));
  const store = openMessageQueueStore(path.join(directory, "queue.sqlite3"));
  const seen: { prompt: string; messageId: number | undefined }[] = [];
  const deps: MessageDeliveryHandlerDeps = {
    resolveAgent: async (name) => ({ name }) as HerdrAgent,
    submitToAgent: async (_agent, _senderName, prompt, options) => {
      seen.push({ prompt, messageId: options.messageId });
    },
    clearBlockedState: async () => undefined,
    readAgentRole: async () => ({ status: "field-absent" }),
    readAgentSupervisor: async () => ({ status: "field-absent" }),
    recordDeliveredEvent: async () => undefined,
    sleep: async () => undefined,
    maxNotSentAttempts: 1,
  };
  try {
    const queued = store.insertWorkItem({
      kind: "delivery",
      payload: { recipientName: "regent", senderName: "stager-eleventh", prompt: "PR 157 is green" },
      maximumAttempts: 1,
    });
    const claimed = store.claimDueWorkItem(queued.id);
    assert.ok(claimed);
    await deliverMessageWorkItem(store, claimed, deps);
    assert.deepEqual(seen, [{ prompt: "PR 157 is green", messageId: queued.id }]);
    assert.equal(
      submittedPayload("stager-eleventh", seen[0]!.prompt, { messageId: seen[0]!.messageId }),
      `<message${queued.id}>\nstager-eleventh said: PR 157 is green\n</message${queued.id}>`,
    );
  } finally {
    store.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});
