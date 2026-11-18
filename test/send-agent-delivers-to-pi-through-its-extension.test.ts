import { test } from "node:test";
import assert from "node:assert/strict";
import { HARNESS_NAMES } from "../src/harness-routing/harness.ts";
import { SOCKET_STARTUP_WAIT_MS, submitToAgentWhileLocked } from "../src/herdr/herdr-send-transaction.ts";
import { SubmitNotSentError, type SubmitToAgentDeps } from "../src/herdr/herdr-send.types.ts";
import { deliverToPi } from "../src/herdr/pi-delivery-client.ts";
import { agentAlive } from "../src/herdr/delivery-request-client.ts";
import { inspectSupportedAgentScreen } from "../src/codex-screen/composer/composer.service.ts";
import { fakeVirtualClock } from "../src/herdr/herdr-send-test-fixtures.ts";
import { createStubRecipient, type StubRecipient } from "./stub-recipient.ts";

const PANE = "w9:pi1";
const PI_AGENT = {
  agent: HARNESS_NAMES.PI, name: "shadow-pi", agentStatus: "idle" as const, cwd: "",
  focused: false, paneId: PANE, tabId: "tab", terminalId: "terminal",
};

const BORDER = "─".repeat(40);

function piFrame(composer: string): string {
  return ["", " earlier answer", "", BORDER, composer, BORDER, "/repo (main)", "↑1k ↓2 deepseek-flash • low"].join("\n");
}

function typingPiPane(initialComposer = "") {
  let composer = initialComposer;
  const typed: string[] = [];
  const submitted: string[] = [];
  return {
    typed,
    submitted,
    clearDraft: () => { composer = ""; },
    deps: {
      getPaneProcessInfo: async (paneId: string) => ({ paneId, foregroundProcesses: [{ pid: 1, name: "pi", argv: ["pi"] }] }),
      readVisibleAgentAnsi: async () => piFrame(composer),
      readRecentAgentAnsi: async () => piFrame(composer),
      sendText: async (_pane: string, text: string) => { typed.push(text); composer = text; },
      pressEnter: async () => { if (composer !== "") submitted.push(composer); composer = ""; },
      pressPaneKey: async () => { if (composer !== "") submitted.push(composer); composer = ""; },
    },
  };
}

function piDeps(recipient: StubRecipient) {
  const typed: string[] = [];
  const fallbackLines: string[] = [];
  const refuse = (kind: string) => async () => {
    typed.push(kind);
    throw new Error(`refused ${kind}`);
  };
  const deps = {
    sendText: refuse("send-text"),
    pressEnter: refuse("send-keys"),
    pressPaneKey: refuse("send-keys"),
    readVisibleAgentAnsi: refuse("agent read"),
    readRecentAgentAnsi: refuse("agent read"),
    getPaneProcessInfo: refuse("pane process read"),
    deliverThroughExtension: refuse("claude mod delivery"),
    claudeMod: { usesMod: async () => false, socketOf: async () => undefined, alive: async () => undefined, log: (line: string) => fallbackLines.push(line) },
    deliverToPi: (text: string, timeoutMs: number, target: { paneId: string; agentName: string }, messageId?: number) =>
      deliverToPi(text, timeoutMs, target, messageId, { socketPath: recipient.socketPath }),
  } as unknown as SubmitToAgentDeps;
  return { typed, fallbackLines, deps };
}

test("a message to a pi agent goes over its socket and never types or reads the pane", async () => {
  const recipient = await createStubRecipient({ pane: PANE, harness: "pi" });
  const room = piDeps(recipient);
  try {
    const payload = await submitToAgentWhileLocked(PI_AGENT, "sender", "hello", { messageId: 7 }, room.deps);
    assert.match(payload ?? "", /hello/u);
    assert.deepEqual(room.typed, []);
    assert.deepEqual(recipient.submitted.map((request) => request.id), ["message-7"]);
  } finally {
    await recipient.dispose();
  }
});

test("a pi agent that holds the message past the wait is not sent and nothing is typed", async () => {
  const recipient = await createStubRecipient({ pane: PANE, harness: "pi", state: { kind: "resident-draft", text: "half typed" } });
  const room = piDeps(recipient);
  try {
    await assert.rejects(
      submitToAgentWhileLocked(PI_AGENT, "sender", "hello", { messageId: 11, composerWaitMilliseconds: 300 }, room.deps),
      (error: unknown) => error instanceof SubmitNotSentError,
    );
    assert.deepEqual(room.typed, []);
    assert.deepEqual(recipient.submitted, []);
  } finally {
    await recipient.dispose();
  }
});

test("a second attempt at the same message after a backend restart is answered delivered without submitting it again", async () => {
  const recipient = await createStubRecipient({ pane: PANE, harness: "pi" });
  try {
    const target = { paneId: PANE, agentName: "shadow-pi" };
    assert.deepEqual(await deliverToPi("hello", 1_000, target, 9, { socketPath: recipient.socketPath }), { kind: "delivered" });
    assert.deepEqual(await deliverToPi("hello", 1_000, target, 9, { socketPath: recipient.socketPath }), { kind: "delivered" });
    assert.equal(recipient.submitted.length, 1);
  } finally {
    await recipient.dispose();
  }
});

test("an empty pi composer on screen is read as empty and one holding a draft is read as that draft", () => {
  assert.deepEqual(inspectSupportedAgentScreen(HARNESS_NAMES.PI, piFrame("")).activeComposer, { state: "empty", text: "" });
  assert.deepEqual(inspectSupportedAgentScreen(HARNESS_NAMES.PI, piFrame("person draft pi keep me")).activeComposer, { state: "draft", text: "person draft pi keep me" });
  assert.deepEqual(inspectSupportedAgentScreen(HARNESS_NAMES.PI, " no editor here").activeComposer, { state: "unavailable" });
});

test("a pi agent whose socket is gone gets the message by typed keys with exactly one fallback line", async () => {
  const recipient = await createStubRecipient({ pane: PANE, harness: "pi" });
  await recipient.stopListening();
  const room = piDeps(recipient);
  const pane = typingPiPane();
  try {
    const payload = await submitToAgentWhileLocked(PI_AGENT, "sender", "hello", { messageId: 21 }, { ...room.deps, ...fakeVirtualClock(), ...pane.deps });
    assert.equal(pane.submitted.length, 1);
    assert.equal(pane.submitted[0], payload);
    assert.equal(room.fallbackLines.length, 1);
  } finally {
    await recipient.dispose();
  }
});

test("a typed message to a socketless pi composer holding a draft is not sent and leaves the draft, and its retry logs no second fallback line", async () => {
  const recipient = await createStubRecipient({ pane: PANE, harness: "pi" });
  await recipient.stopListening();
  const room = piDeps(recipient);
  const pane = typingPiPane("person draft");
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        submitToAgentWhileLocked(PI_AGENT, "sender", "hello", { messageId: 22, composerWaitMilliseconds: 0 }, { ...room.deps, ...fakeVirtualClock(), ...pane.deps }),
        (error: unknown) => error instanceof SubmitNotSentError,
      );
    }
    assert.deepEqual(pane.typed, []);
    assert.deepEqual(pane.submitted, []);
    assert.equal(room.fallbackLines.length, 1);
  } finally {
    await recipient.dispose();
  }
});

test("a typed message to a socketless pi composer holding a draft waits for the person to clear it and is then typed once", async () => {
  const recipient = await createStubRecipient({ pane: PANE, harness: "pi" });
  await recipient.stopListening();
  const room = piDeps(recipient);
  const pane = typingPiPane("person draft");
  const clock = fakeVirtualClock();
  let sleeps = 0;
  const sleep = async (milliseconds: number) => { sleeps += 1; if (sleeps === 3) pane.clearDraft(); await clock.sleep(milliseconds); };
  try {
    const payload = await submitToAgentWhileLocked(PI_AGENT, "sender", "hello", { messageId: 23, composerWaitMilliseconds: 60_000 }, { ...room.deps, ...clock, sleep, ...pane.deps });
    assert.deepEqual(pane.submitted, [payload]);
    assert.equal(room.fallbackLines.length, 1);
  } finally {
    await recipient.dispose();
  }
});

function startupChecks(room: ReturnType<typeof piDeps>, recipient: StubRecipient, answersFromPoll: number) {
  let polls = 0;
  return {
    usesMod: async () => false,
    socketOf: async () => recipient.socketPath,
    alive: async (socketPath: string | undefined, paneId: string) => {
      polls += 1;
      return polls > answersFromPoll ? agentAlive(socketPath, paneId) : undefined;
    },
    log: (line: string) => room.fallbackLines.push(line),
  };
}

test("a pi recipient whose socket starts answering after the first poll gets its opening prompt through the socket with nothing typed", async () => {
  const recipient = await createStubRecipient({ pane: PANE, harness: "pi" });
  const room = piDeps(recipient);
  try {
    const deps = { ...room.deps, ...fakeVirtualClock(), claudeMod: startupChecks(room, recipient, 1) };
    await submitToAgentWhileLocked(PI_AGENT, "sender", "hello", { messageId: 31, waitForStartupQuiescence: true }, deps);
    assert.deepEqual(recipient.submitted.map((request) => request.id), ["message-31"]);
    assert.deepEqual(room.typed, []);
    assert.deepEqual(room.fallbackLines, []);
  } finally {
    await recipient.dispose();
  }
});

test("a pi recipient whose socket never answers ends not answering after the startup limit and is typed once with one fallback line", async () => {
  const recipient = await createStubRecipient({ pane: PANE, harness: "pi" });
  await recipient.stopListening();
  const room = piDeps(recipient);
  const pane = typingPiPane();
  const clock = fakeVirtualClock();
  try {
    const startedAt = clock.now();
    const deps = { ...room.deps, ...clock, ...pane.deps, claudeMod: startupChecks(room, recipient, 0) };
    const payload = await submitToAgentWhileLocked(PI_AGENT, "sender", "hello", { messageId: 32, waitForStartupQuiescence: true }, deps);
    assert.ok(clock.now() - startedAt >= SOCKET_STARTUP_WAIT_MS);
    assert.deepEqual(pane.submitted, [payload]);
    assert.equal(room.fallbackLines.length, 1);
  } finally {
    await recipient.dispose();
  }
});
