import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir } from "node:fs/promises";
import { deliverToOmp } from "../src/herdr/omp-delivery-client.ts";
import { submitToAgentWhileLocked } from "../src/herdr/herdr-send-transaction.ts";
import { SubmitNotSentError, type SubmitToAgentDeps } from "../src/herdr/herdr-send.types.ts";
import { HARNESS_NAMES } from "../src/harness-routing/harness.ts";
import { createStubRecipient, UNRECOGNIZED_COMPOSER_DETAIL } from "./stub-recipient.ts";
const PANE = "stub-pane";


function assertReceivedRequestExactlyOnce(
  recipient: { receivedRequestBytes(): readonly string[] },
  text: string,
  paneId: string = PANE,
): void {
  const received = recipient.receivedRequestBytes();
  assert.equal(received.length, 1);
  const request = JSON.parse(received[0]!) as { id: string };
  assert.deepEqual(received, [`${JSON.stringify({ id: request.id, text, paneId })}\n`]);
}

test("a configurable recipient captures the direct OMP request byte-for-byte and acknowledges it", async () => {
  const recipient = await createStubRecipient();
  const payload = "payload with \\n preserved";
  try {
    const outcome = await deliverToOmp(payload, 100, PANE, {
      directory: recipient.directory,
      sleep: () => recipient.processPendingDelivery(),
    });
    assert.deepEqual(outcome, { kind: "delivered" });
    assert.equal(recipient.deliveryCount(), 1);
    const received = recipient.receivedRequestBytes()[0]!;
    const request = JSON.parse(received) as { id: string };
    assert.deepEqual(recipient.receivedRequestBytes(), [
      `${JSON.stringify({ id: request.id, text: payload, paneId: PANE })}\n`,
    ]);
  } finally {
    await recipient.dispose();
  }
});

test("a resident-draft recipient records its request exactly once before delivery and preserves the draft", async () => {
  const draft = "do not overwrite this";
  const recipient = await createStubRecipient({ kind: "resident-draft", text: draft });
  try {
    const outcome = await deliverToOmp("next message", 100, PANE, {
      directory: recipient.directory,
      sleep: async () => {
        await recipient.processPendingDelivery();
        assert.deepEqual(recipient.paneProjection(), {
          status: "in-flight", composer: "draft", text: draft,
        });
        assert.equal(recipient.deliveryCount(), 0);
        assertReceivedRequestExactlyOnce(recipient, "next message");
        recipient.setState({ kind: "acknowledge" });
        await recipient.processPendingDelivery();
      },
    });
    assert.deepEqual(outcome, { kind: "delivered" });
    assert.equal(recipient.deliveryCount(), 1);
    assertReceivedRequestExactlyOnce(recipient, "next message");
  } finally {
    await recipient.dispose();
  }
});

test("an unrecognised composer returns its exact refusal detail", async () => {
  const recipient = await createStubRecipient({
    kind: "refuse", detail: UNRECOGNIZED_COMPOSER_DETAIL,
  });
  try {
    const outcome = await deliverToOmp("hello", 100, PANE, {
      directory: recipient.directory,
      sleep: () => recipient.processPendingDelivery(),
    });
    assert.deepEqual(outcome, { kind: "refused", detail: UNRECOGNIZED_COMPOSER_DETAIL });
    assert.deepEqual(recipient.paneProjection(), {
      status: "not-sent", composer: "unrecognized", detail: UNRECOGNIZED_COMPOSER_DETAIL,
    });
  } finally {
    await recipient.dispose();
  }
});

test("a silent OMP recipient becomes typed not-sent only after withdrawal and cannot deliver on a later pickup", async () => {
  const recipient = await createStubRecipient({ kind: "unreadable" });
  let clock = 0;
  const deps = {
    deliverToOmp: (text: string, timeoutMs: number, recipientPaneId: string) => deliverToOmp(text, timeoutMs, recipientPaneId, {
      directory: recipient.directory,
      now: () => clock,
      sleep: async () => { clock += 10; await recipient.processPendingDelivery(); },
    }),
  } as SubmitToAgentDeps;
  try {
    await assert.rejects(
      submitToAgentWhileLocked({
        agent: HARNESS_NAMES.OMP, name: "stub", agentStatus: "idle", cwd: "",
        focused: false, paneId: "pane", tabId: "tab", terminalId: "terminal",
      }, "sender", "hello", { composerWaitMilliseconds: 20 }, deps),
      (error: unknown) => error instanceof SubmitNotSentError,
    );
    assert.equal(clock, 20);
    assertReceivedRequestExactlyOnce(recipient, "sender said: hello", "pane");
    assert.deepEqual(recipient.paneProjection(), { status: "in-flight", composer: "unreadable" });
    assert.deepEqual((await readdir(recipient.directory)).filter((entry) => entry.startsWith("req-")), []);

    recipient.setState({ kind: "acknowledge" });
    await recipient.processPendingDelivery();

    assert.equal(recipient.deliveryCount(), 0);
    assert.deepEqual((await readdir(recipient.directory)).filter((entry) => entry.startsWith("req-")), []);
  } finally {
    await recipient.dispose();
  }
});

test("an unreadable OMP recipient returns a real typed not-sent failure within one second", async () => {
  const recipient = await createStubRecipient({ kind: "unreadable" });
  const deps = {
    deliverToOmp: (text: string, timeoutMs: number, recipientPaneId: string) => deliverToOmp(
      text,
      timeoutMs,
      recipientPaneId,
      { directory: recipient.directory },
    ),
  } as SubmitToAgentDeps;
  try {
    const startedAt = performance.now();
    await assert.rejects(
      submitToAgentWhileLocked({
        agent: HARNESS_NAMES.OMP, name: "stub", agentStatus: "idle", cwd: "",
        focused: false, paneId: "pane", tabId: "tab", terminalId: "terminal",
      }, "sender", "hello", { composerWaitMilliseconds: 20 }, deps),
      (error: unknown) => error instanceof SubmitNotSentError,
    );
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 1_000, `expected bounded OMP failure under 1000ms, received ${elapsedMs}ms`);
    assert.deepEqual((await readdir(recipient.directory)).filter((entry) => entry.startsWith("req-")), []);
  } finally {
    await recipient.dispose();
  }
});

test("a never-answer recipient records its request before bounded direct withdrawal", async () => {
  const recipient = await createStubRecipient({ kind: "never-answer" });
  let clock = 0;
  try {
    const outcome = await deliverToOmp("hello", 20, PANE, {
      directory: recipient.directory,
      now: () => clock,
      sleep: async () => { clock += 10; await recipient.processPendingDelivery(); },
    });
    assert.deepEqual(outcome, { kind: "timed-out", waitedMs: 20 });
    assert.deepEqual((await readdir(recipient.directory)).filter((entry) => entry.startsWith("req-")), []);
    assertReceivedRequestExactlyOnce(recipient, "hello");
  } finally {
    await recipient.dispose();
  }
});
