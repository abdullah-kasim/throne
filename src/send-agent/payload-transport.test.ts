import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { realDepsRootedAt } from "../../test/filebacked-payload-root.ts";
import { baseDeps, baseRequest } from "../create-agent/policy-test-fixtures.ts";
import type { PolicyResolution } from "../create-agent/create.types.ts";
import { deliverAgentOpeningPrompt } from "../create-agent/opening-prompt.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { deliverOpeningPrompt } from "../herdr/herdr-opening-prompt.ts";
import { submittedPayload } from "../herdr/herdr-send.helpers.ts";
import { submitToAgent } from "../herdr/herdr-send.service.ts";
import type {
  SubmitToAgentDeps,
  SubmitToAgentOptions,
} from "../herdr/herdr-send.types.ts";
import {
  MessageQueueWorkItemState,
  openMessageQueueStore,
} from "../message-queue/message-queue.store.ts";
import { fakeSubmitToAgentDeps } from "../no-idling/no-idling-command-test-fixtures.ts";
import {
  deliverMessageWorkItem,
  type MessageDeliveryHandlerDeps,
} from "../throne-work/message-delivery-handler.ts";
import { stagePayload } from "./payload-transport.ts";

const INLINE_LIMIT_BYTES = 768;
const SENDER_NAME = "alpha-example-01";
const QUEUED_MESSAGE: SubmitToAgentOptions = { messageId: 41 };
const POINTER_LINE = /Large message — read then delete: .+ read-payload "([^"]+)"/u;

const RECIPIENT_PANE = {
  agent: "unknown",
  name: "shadow-example-02",
  agentStatus: "idle",
  cwd: "/tmp/shadow-example-02",
  focused: false,
  paneId: "pane-7",
  tabId: "tab-7",
  terminalId: "terminal-7",
} as HerdrAgent;

interface FakePane {
  readonly typedTexts: string[];
  readonly payloadRoot: string;
  readonly submitDeps: SubmitToAgentDeps;
}

async function withFakePane(run: (pane: FakePane) => Promise<void>): Promise<void> {
  const payloadRoot = await mkdtemp(path.join(tmpdir(), "throne-inline-limit-"));
  const typedTexts: string[] = [];
  try {
    await run({
      typedTexts,
      payloadRoot,
      submitDeps: {
        ...fakeSubmitToAgentDeps(typedTexts),
        stagePayload: (recipient, body) =>
          stagePayload(recipient, body, realDepsRootedAt(payloadRoot)),
        fileBackedPayloadsEnabled: true,
      },
    });
  } finally {
    await rm(payloadRoot, { recursive: true, force: true });
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function typedTextOf(prompt: string, options: SubmitToAgentOptions): string {
  return submittedPayload(SENDER_NAME, prompt, options);
}

function promptWhoseTypedTextIs(bytes: number, options: SubmitToAgentOptions): string {
  return "x".repeat(bytes - byteLength(typedTextOf("", options)));
}

async function stagedPayloadNamedBy(pane: FakePane): Promise<string> {
  assert.equal(pane.typedTexts.length, 1);
  const pointer = POINTER_LINE.exec(pane.typedTexts[0]!);
  assert.ok(pointer, `expected a file pointer, the pane was typed: ${pane.typedTexts[0]}`);
  return readFile(path.join(pane.payloadRoot, path.basename(pointer[1]!)), "utf8");
}

async function deliverOpeningPromptThroughTheQueue(
  openingPrompt: string,
  pane: FakePane,
): Promise<void> {
  const databasePath = path.join(pane.payloadRoot, "queue.sqlite3");
  await deliverAgentOpeningPrompt(
    baseRequest({ launchHarness: HARNESS_NAMES.CODEX }) as PolicyResolution,
    baseDeps({
      resolveAgent: async () => RECIPIENT_PANE,
      openMessageQueueStore: () => openMessageQueueStore(databasePath),
    }),
    openingPrompt,
    true,
  );
  const store = openMessageQueueStore(databasePath);
  const handlerDeps: MessageDeliveryHandlerDeps = {
    resolveAgent: async () => RECIPIENT_PANE,
    submitToAgent: (agent, senderName, prompt, options) =>
      submitToAgent(agent, senderName, prompt, options, pane.submitDeps),
    recordDeliveredEvent: async () => null,
    readAgentRole: async () => ({ status: "field-absent" }),
    readAgentSupervisor: async () => ({ status: "field-absent" }),
    clearBlockedMarker: async () => undefined,
    maxNotSentAttempts: 1,
    sleep: async () => undefined,
  };
  try {
    const [queued] = store.listWorkItemsByStates([MessageQueueWorkItemState.Queued]);
    assert.ok(queued);
    const claimed = store.claimDueWorkItem(queued.id);
    assert.ok(claimed);
    const finished = await deliverMessageWorkItem(store, claimed, handlerDeps);
    assert.equal(finished.state, MessageQueueWorkItemState.Delivered, finished.failureReason ?? "");
  } finally {
    store.close();
  }
}

async function typeOpeningPromptDirectly(openingPrompt: string, pane: FakePane): Promise<void> {
  await deliverOpeningPrompt(RECIPIENT_PANE.name!, openingPrompt, {}, {
    resolveAgent: async () => RECIPIENT_PANE,
    submitToAgent: (agent, senderName, prompt, options) =>
      submitToAgent(agent, senderName, prompt, options, pane.submitDeps),
    sleep: async () => undefined,
  });
}

test("a message whose attributed text is under 768 bytes is typed into the pane", async () => {
  await withFakePane(async (pane) => {
    const prompt = promptWhoseTypedTextIs(INLINE_LIMIT_BYTES - 1, QUEUED_MESSAGE);
    await submitToAgent(RECIPIENT_PANE, SENDER_NAME, prompt, QUEUED_MESSAGE, pane.submitDeps);
    assert.equal(byteLength(typedTextOf(prompt, QUEUED_MESSAGE)), INLINE_LIMIT_BYTES - 1);
    assert.deepEqual(pane.typedTexts, [typedTextOf(prompt, QUEUED_MESSAGE)]);
    assert.deepEqual(await readdir(pane.payloadRoot), []);
  });
});

test("a message whose attributed text is 768 bytes or more is delivered as a file pointer", async () => {
  await withFakePane(async (pane) => {
    const prompt = promptWhoseTypedTextIs(INLINE_LIMIT_BYTES, QUEUED_MESSAGE);
    await submitToAgent(RECIPIENT_PANE, SENDER_NAME, prompt, QUEUED_MESSAGE, pane.submitDeps);
    assert.equal(byteLength(typedTextOf(prompt, QUEUED_MESSAGE)), INLINE_LIMIT_BYTES);
    assert.equal(await stagedPayloadNamedBy(pane), prompt);
    assert.ok(byteLength(pane.typedTexts[0]!) < INLINE_LIMIT_BYTES);
  });
});

test("the inline limit counts bytes and not characters", async () => {
  await withFakePane(async (pane) => {
    const prompt = "é".repeat(INLINE_LIMIT_BYTES / 2);
    const typedText = typedTextOf(prompt, QUEUED_MESSAGE);
    assert.ok(typedText.length < INLINE_LIMIT_BYTES);
    assert.ok(byteLength(typedText) >= INLINE_LIMIT_BYTES);
    await submitToAgent(RECIPIENT_PANE, SENDER_NAME, prompt, QUEUED_MESSAGE, pane.submitDeps);
    assert.equal(await stagedPayloadNamedBy(pane), prompt);
  });
});

test("a long opening prompt is delivered as a file pointer like any other long message", async () => {
  const promptThatOnlyItsMessageNumberPushesToTheLimit = "x".repeat(INLINE_LIMIT_BYTES - 1);
  const longPrompts = [promptThatOnlyItsMessageNumberPushesToTheLimit, "x".repeat(3000)];
  for (const openingPrompt of longPrompts) {
    await withFakePane(async (pane) => {
      await deliverOpeningPromptThroughTheQueue(openingPrompt, pane);
      assert.equal(await stagedPayloadNamedBy(pane), openingPrompt);
    });
  }
  await withFakePane(async (pane) => {
    const openingPrompt = "x".repeat(INLINE_LIMIT_BYTES);
    await typeOpeningPromptDirectly(openingPrompt, pane);
    assert.equal(await stagedPayloadNamedBy(pane), openingPrompt);
  });
});

test("a short opening prompt is still typed into the pane", async () => {
  const openingPrompt = "You are `shadow-example-02` (Shadow). Read your charge from the ledger.";
  await withFakePane(async (pane) => {
    await deliverOpeningPromptThroughTheQueue(openingPrompt, pane);
    assert.deepEqual(pane.typedTexts, [`${openingPrompt} [message 1]`]);
  });
  await withFakePane(async (pane) => {
    await typeOpeningPromptDirectly(openingPrompt, pane);
    assert.deepEqual(pane.typedTexts, [openingPrompt]);
  });
});
