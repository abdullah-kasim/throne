import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { claudeComposerLine, claudeScreen, DIM_HINT } from "../../test/claude-screens.ts";
import { openMessageQueueStore } from "../message-queue/message-queue.store.ts";
import {
  PaneLockTakenOverError,
  REAL_RECIPIENT_PANE_LOCK_DEPS,
  RecipientPaneLockService,
} from "../shared-policy/recipient-pane-lock.service.ts";
import {
  deliverMessageWorkItem,
  type MessageDeliveryHandlerDeps,
} from "../throne-work/message-delivery-handler.ts";
import { writeToPaneHoldingItsLock } from "./herdr-client.ts";
import type { HerdrAgent } from "./herdr-inventory.service.ts";
import type { SubmitToAgentDeps } from "./herdr-send.types.ts";
import { submitToAgentUnkeyed } from "./herdr-send-unkeyed.ts";
import { fakeClaudeAgent, fakeVirtualClock } from "./herdr-send-test-fixtures.ts";

const HOLDER_PROCESS_ID = 1111;
const SENDER_PROCESS_ID = 2222;

interface Pane {
  typed: string[];
}

function sendDeps(
  pane: Pane,
  clock: { nowMs: number },
  lockDirectory: string,
  processId: number,
  afterWrite: () => Promise<void> = async () => {},
): SubmitToAgentDeps {
  const service = new RecipientPaneLockService();
  return {
    sendText: (paneId: string, text: string) =>
      writeToPaneHoldingItsLock(paneId, async () => {
        pane.typed.push(text);
        await afterWrite();
      }),
    pressEnter: (paneId: string) =>
      writeToPaneHoldingItsLock(paneId, async () => {
        pane.typed.push(`Enter from ${processId}`);
      }),
    forceEnter: async () => {
      pane.typed.push("forced Enter");
    },
    withRecipientPaneLock: (paneId, action, options) =>
      service.withRecipientPaneLock(paneId, action, { ...options, throneHome: lockDirectory }, {
        ...REAL_RECIPIENT_PANE_LOCK_DEPS,
        now: () => clock.nowMs,
        sleep: () => new Promise(() => {}),
      }),
  } as Partial<SubmitToAgentDeps> as SubmitToAgentDeps;
}

async function holderDisplacedBetweenWriteAndEnter(pane: Pane, agent: HerdrAgent) {
  const lockDirectory = await mkdtemp(path.join(tmpdir(), "pane-lock-takeover-"));
  const clock = { nowMs: 1_000_000 };
  let signalWritten!: () => void;
  const written = new Promise<void>((resolve) => { signalWritten = resolve; });
  let signalTakenOver!: () => void;
  const takenOver = new Promise<void>((resolve) => { signalTakenOver = resolve; });
  const holderDeps = sendDeps(pane, clock, lockDirectory, HOLDER_PROCESS_ID, async () => {
    signalWritten();
    await takenOver;
  });
  const holder = submitToAgentUnkeyed(agent, "holder", "old text", { forceImmediate: true }, holderDeps);
  await written;
  clock.nowMs += 61_000;
  const sender = await submitToAgentUnkeyed(
    agent,
    "sender",
    "new message",
    { forceImmediate: true },
    sendDeps(pane, clock, lockDirectory, SENDER_PROCESS_ID),
  );
  signalTakenOver();
  return { holder, sender };
}

test("a takeover that lands between a holder's write and its Enter stops the holder before it presses Enter", async (context: TestContext) => {
  context.mock.method(console, "warn", () => {});
  const pane: Pane = { typed: [] };

  const { holder } = await holderDisplacedBetweenWriteAndEnter(pane, fakeClaudeAgent());

  await assert.rejects(holder, PaneLockTakenOverError);
  assert.equal(pane.typed.includes(`Enter from ${HOLDER_PROCESS_ID}`), false);
});

test("the sender that took over a pane lock delivers its own message whole after the forced Enter", async (context: TestContext) => {
  context.mock.method(console, "warn", () => {});
  const pane: Pane = { typed: [] };

  const { holder, sender } = await holderDisplacedBetweenWriteAndEnter(pane, fakeClaudeAgent());
  await holder.catch(() => {});

  assert.equal(sender, "sender said: new message");
  assert.deepEqual(pane.typed, [
    "holder said: old text",
    "forced Enter",
    "sender said: new message",
    `Enter from ${SENDER_PROCESS_ID}`,
  ]);
});

test("a delivery whose pane lock was taken over fails with that reason and is not retried", async (context: TestContext) => {
  context.mock.method(console, "warn", () => {});
  const directory = await mkdtemp(path.join(homedir(), "tmp", "pane-lock-takeover-queue-"));
  const store = openMessageQueueStore(path.join(directory, "queue.sqlite3"));
  let attempts = 0;
  const deps: MessageDeliveryHandlerDeps = {
    resolveAgent: async () => fakeClaudeAgent(),
    submitToAgent: async (agent) => {
      attempts += 1;
      const { holder } = await holderDisplacedBetweenWriteAndEnter({ typed: [] }, agent);
      return holder;
    },
    clearBlockedState: async () => undefined,
    readAgentRole: async () => ({ status: "field-absent" }),
    readAgentSupervisor: async () => ({ status: "field-absent" }),
    recordDeliveredEvent: async () => null,
    sleep: async () => undefined,
    maxNotSentAttempts: 3,
  };
  try {
    const queued = store.insertWorkItem({
      kind: "delivery",
      payload: { recipientName: "recipient", senderName: "holder", prompt: "old text" },
      maximumAttempts: 3,
    });
    const claimed = store.claimDueWorkItem(queued.id);
    assert.ok(claimed);

    const finished = await deliverMessageWorkItem(store, claimed, deps);

    assert.equal(attempts, 1);
    assert.equal(finished.state, "failed");
    assert.match(String(finished.failureReason), /taken over after a minute/);
  } finally {
    store.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a send to a pane whose lock is a minute old with text left in the box takes over without waiting for the box to clear", { timeout: 5_000 }, async (context: TestContext) => {
  context.mock.method(console, "warn", () => {});
  const lockDirectory = await mkdtemp(path.join(tmpdir(), "pane-lock-takeover-draft-"));
  const clock = { nowMs: 1_000_000 };
  const agent = fakeClaudeAgent();
  const lockDeps = () => ({
    ...REAL_RECIPIENT_PANE_LOCK_DEPS,
    now: () => clock.nowMs,
    sleep: () => new Promise<void>(() => {}),
  });
  const service = new RecipientPaneLockService();
  let finishHolding!: () => void;
  const holding = new Promise<void>((resolve) => { finishHolding = resolve; });
  let signalHeld!: () => void;
  const held = new Promise<void>((resolve) => { signalHeld = resolve; });
  const holder = service.withRecipientPaneLock(agent.paneId, async () => {
    signalHeld();
    await holding;
  }, { throneHome: lockDirectory }, lockDeps());
  await held;
  clock.nowMs += 61_000;
  const emptyScreen = claudeScreen(claudeComposerLine(DIM_HINT));
  let screen = claudeScreen(claudeComposerLine("holder said: old text"));
  const typed: string[] = [];
  const senderDeps = {
    ...fakeVirtualClock(),
    getPaneProcessInfo: async (paneId: string) => ({
      paneId,
      foregroundProcesses: [{ name: "claude", argv: ["claude"] }],
    }),
    readVisibleAgentAnsi: async () => screen,
    readRecentAgentAnsi: async () => screen,
    refreshRecipientIdentity: async (_name: string, initial: HerdrAgent) => initial,
    forceEnter: async () => {
      typed.push("forced Enter");
      screen = emptyScreen;
    },
    sendText: async (_paneId: string, text: string) => {
      typed.push(text);
      screen = claudeScreen(claudeComposerLine(text));
    },
    pressEnter: async () => {
      typed.push(`Enter from ${SENDER_PROCESS_ID}`);
      screen = emptyScreen;
    },
    pressPaneKey: async () => {},
    isRecipientPaneLockHeld: (paneId: string) =>
      service.isHeldByAnotherSender(paneId, { throneHome: lockDirectory }, lockDeps()),
    withRecipientPaneLock: (paneId, action, options) =>
      service.withRecipientPaneLock(paneId, action, { ...options, throneHome: lockDirectory }, lockDeps()),
  } as Partial<SubmitToAgentDeps> as SubmitToAgentDeps;
  try {
    await submitToAgentUnkeyed(agent, "sender", "new message", {}, senderDeps);

    assert.deepEqual(typed.slice(0, 3), ["forced Enter", "sender said: new message", `Enter from ${SENDER_PROCESS_ID}`]);
  } finally {
    finishHolding();
    await holder.catch(() => {});
    await rm(lockDirectory, { recursive: true, force: true });
  }
});
