import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DeliveryRequest } from "../../extensions/shared/agent-delivery-contract.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { MessageQueueWorkItemState, openMessageQueueStore } from "../message-queue/message-queue.store.ts";
import { deliverMessageWorkItem, REAL_MESSAGE_DELIVERY_HANDLER_DEPS } from "../throne-work/message-delivery-handler.ts";
import { deliverThroughExtension } from "./delivery-request-client.ts";
import { fakeVirtualClock } from "./herdr-send-test-fixtures.ts";
import { fakeWindowStore } from "../no-idling/no-idling-command-test-fixtures.ts";
import { submitToAgent } from "./herdr-send.service.ts";
import { submitToAgentWhileLocked } from "./herdr-send-transaction.ts";
import type { SubmitToAgentDeps } from "./herdr-send.types.ts";
import { deliverToPi } from "./pi-delivery-client.ts";

const PANE = "w9:pi1";
const PI_AGENT = {
  agent: HARNESS_NAMES.PI, name: "shadow-pi", agentStatus: "idle" as const, cwd: "",
  focused: false, paneId: PANE, tabId: "tab", terminalId: "terminal",
};

type Behaviour = "accept" | "drop-then-accept" | "deliver";

interface FakeAgent {
  readonly socketPath: string;
  readonly requests: DeliveryRequest[];
  dispose(): Promise<void>;
}

async function fakeAgent(callbacks: boolean, behaviour: Behaviour): Promise<FakeAgent> {
  const folder = await mkdtemp(path.join(tmpdir(), "acknowledged-delivery-"));
  const socketPath = path.join(folder, "agent.sock");
  const requests: DeliveryRequest[] = [];
  const server: Server = createServer((incoming, outgoing) => {
    if (incoming.method === "GET") {
      outgoing.end(JSON.stringify({ pane: PANE, harness: "pi", commands: false, ...(callbacks ? { callbacks: true } : {}) }));
      return;
    }
    const pieces: Buffer[] = [];
    incoming.on("data", (piece: Buffer) => pieces.push(piece));
    incoming.on("end", () => {
      const request = JSON.parse(Buffer.concat(pieces).toString("utf8")) as DeliveryRequest;
      requests.push(request);
      if (behaviour === "drop-then-accept" && requests.length === 1) {
        incoming.socket.destroy();
        return;
      }
      const status = behaviour === "deliver" ? { status: "delivered", as: "turn" } : { status: "accepted" };
      outgoing.end(JSON.stringify({ id: request.id, pane: request.pane, ...status }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    requests,
    async dispose() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(folder, { recursive: true, force: true });
    },
  };
}

function piTransactionDeps(socketPath: string, typed: string[] = []): SubmitToAgentDeps {
  let composer = "";
  const frame = () => ["", " earlier answer", "", "─".repeat(40), composer, "─".repeat(40), "/repo (main)", "↑1k ↓2 deepseek-flash • low"].join("\n");
  return {
    ...fakeVirtualClock(),
    getPaneProcessInfo: async (paneId: string) => ({ paneId, foregroundProcesses: [{ pid: 1, name: "pi", argv: ["pi"] }] }),
    readVisibleAgentAnsi: async () => frame(),
    readRecentAgentAnsi: async () => frame(),
    sendText: async (_pane: string, text: string) => { typed.push(text); composer = text; },
    pressEnter: async () => { composer = ""; },
    pressPaneKey: async () => { composer = ""; },
    claudeMod: { usesMod: async () => false, socketOf: async () => undefined, alive: async () => undefined, log: () => undefined },
    deliverToPi: (text: string, timeoutMs: number, target: { paneId: string; agentName: string }, messageId?: number) =>
      deliverToPi(text, timeoutMs, target, messageId, { socketPath }),
  } as unknown as SubmitToAgentDeps;
}

test("a message to an agent that takes acknowledged delivery ends its attempt when the agent accepts it", async () => {
  const agent = await fakeAgent(true, "accept");
  try {
    let accepted = false;
    await submitToAgentWhileLocked(PI_AGENT, "sender", "hello", { messageId: 3, onAccepted: () => { accepted = true; } }, piTransactionDeps(agent.socketPath));
    assert.equal(accepted, true);
    assert.equal(agent.requests.length, 1);
    assert.equal((agent.requests[0] as { acknowledge?: true }).acknowledge, true);
  } finally {
    await agent.dispose();
  }
});

function storedAsTheQueueStoresIt(): ReturnType<typeof fakeWindowStore> {
  const store = fakeWindowStore();
  return { ...store, claim: (recipient, key, payload, now) => store.claim(recipient, key, JSON.parse(JSON.stringify(payload)), now) };
}

test("a queued message, which always carries a key, still ends its attempt when the agent accepts it", async () => {
  const agent = await fakeAgent(true, "accept");
  try {
    let accepted = false;
    await submitToAgent(PI_AGENT, "sender", "hello", { key: "auto-1", messageId: 7, onAccepted: () => { accepted = true; } }, {
      ...piTransactionDeps(agent.socketPath),
      keyedSubmissionWindowStore: storedAsTheQueueStoresIt(),
      refreshRecipientIdentity: async (_name: string, recipient: typeof PI_AGENT) => recipient,
      withRecipientPaneLock: <T>(_pane: string, action: () => Promise<T>) => action(),
    } as unknown as SubmitToAgentDeps);
    assert.equal(accepted, true);
  } finally {
    await agent.dispose();
  }
});

test("an accepted message moves its row to accepted", async () => {
  const agent = await fakeAgent(true, "accept");
  const directory = await mkdtemp(path.join(tmpdir(), "acknowledged-row-"));
  const store = openMessageQueueStore(path.join(directory, "queue.sqlite3"), () => 1_000);
  try {
    const queued = store.insertWorkItem({ kind: "message-delivery", payload: { senderName: "sender", recipientName: "shadow-pi", prompt: "hello" } });
    const claimed = store.claimDueWorkItem(queued.id)!;
    const finished = await deliverMessageWorkItem(store, claimed, {
      ...REAL_MESSAGE_DELIVERY_HANDLER_DEPS,
      resolveAgent: async () => PI_AGENT,
      submitToAgent: (recipient, sender, prompt, options) => submitToAgentWhileLocked(recipient, sender, prompt, options, piTransactionDeps(agent.socketPath)),
      clearBlockedState: async () => undefined,
      readAgentRole: async () => ({ kind: "missing" }) as never,
      readAgentSupervisor: async () => ({ kind: "missing" }) as never,
      recordDeliveredEvent: async () => undefined as never,
      markAgentTasked: async () => undefined,
      appendSentMessageLedgerEntry: async () => undefined,
    });
    assert.equal(finished.state, MessageQueueWorkItemState.Accepted);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
    await agent.dispose();
  }
});

test("an agent launched before acknowledged delivery still receives messages by the held request", async () => {
  const agent = await fakeAgent(false, "deliver");
  try {
    const outcome = await deliverThroughExtension("hello", 60_000, PANE, { socketPath: agent.socketPath, requestId: "message-4" });
    assert.deepEqual(outcome, { kind: "delivered" });
    assert.deepEqual(agent.requests, [{ id: "message-4", pane: PANE, text: "hello", waitMs: 60_000 }]);
  } finally {
    await agent.dispose();
  }
});

test("a connection dropped before the answer asks again with the same id", async () => {
  const agent = await fakeAgent(true, "drop-then-accept");
  try {
    const outcome = await deliverThroughExtension("hello", 60_000, PANE, { socketPath: agent.socketPath, requestId: "message-5" });
    assert.deepEqual(outcome, { kind: "accepted" });
    assert.deepEqual(agent.requests.map((request) => request.id), ["message-5", "message-5"]);
  } finally {
    await agent.dispose();
  }
});

test("an agent with no socket still gets typed keys", async () => {
  const agent = await fakeAgent(true, "accept");
  const socketPath = agent.socketPath;
  await agent.dispose();
  const typed: string[] = [];
  const payload = await submitToAgentWhileLocked(PI_AGENT, "sender", "hello", { messageId: 6 }, piTransactionDeps(socketPath, typed));
  assert.deepEqual(typed, [payload]);
});

test("no acknowledged delivery holds the connection longer than two seconds", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "acknowledged-silent-"));
  const socketPath = path.join(folder, "agent.sock");
  const held: number[] = [];
  const server = createServer((incoming, outgoing) => {
    if (incoming.method === "GET") {
      outgoing.end(JSON.stringify({ pane: PANE, harness: "pi", commands: false, callbacks: true }));
      return;
    }
    const opened = Date.now();
    incoming.socket.on("close", () => held.push(Date.now() - opened));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await deliverThroughExtension("hello", 900_000, PANE, { socketPath, requestId: "message-8" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(held.length > 0);
    for (const milliseconds of held) assert.ok(milliseconds < 2_000, `held ${milliseconds}ms`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  }
});
