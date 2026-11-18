import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentAlive, deliverThroughExtension } from "../src/herdr/delivery-request-client.ts";
import { createStubRecipient } from "./stub-recipient.ts";

const PANE = "w2:pRECIPIENT";

async function socketAnswering(answer: (request: Record<string, unknown>) => string | undefined) {
  const folder = await mkdtemp(join(tmpdir(), "socket-answer-"));
  const socketPath = join(folder, "agent.sock");
  const closed: string[] = [];
  const server: Server = createServer((incoming, outgoing) => {
    if (incoming.method === "GET") {
      outgoing.end("{}");
      return;
    }
    const pieces: Buffer[] = [];
    incoming.on("data", (piece: Buffer) => pieces.push(piece));
    incoming.on("end", () => {
      const request = JSON.parse(Buffer.concat(pieces).toString("utf8")) as Record<string, unknown>;
      outgoing.on("close", () => {
        if (!outgoing.writableEnded) closed.push(String(request.id));
      });
      const body = answer(request);
      if (body !== undefined) outgoing.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    closed,
    dispose: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(folder, { recursive: true, force: true });
    },
  };
}

test("a request goes to its recipient's socket carrying its id, pane, exact text and wait", async () => {
  const recipient = await createStubRecipient({ pane: PANE });
  try {
    const outcome = await deliverThroughExtension("the whole payload, verbatim", 700, PANE, { socketPath: recipient.socketPath, requestId: "message-4" });
    assert.deepEqual(outcome, { kind: "delivered" });
    assert.deepEqual(recipient.requests, [{ id: "message-4", pane: PANE, text: "the whole payload, verbatim", waitMs: 700 }]);
  } finally {
    await recipient.dispose();
  }
});

test("a command request carries its command and arguments under a command id", async () => {
  const recipient = await createStubRecipient({ pane: PANE });
  try {
    assert.deepEqual(await deliverThroughExtension({ command: "color", args: "red" }, 500, PANE, { socketPath: recipient.socketPath }), { kind: "delivered" });
    assert.equal(recipient.requests.length, 1);
    const [request] = recipient.requests as unknown as Array<Record<string, unknown>>;
    assert.match(String(request?.id), /^command-/u);
    assert.equal(request?.command, "color");
    assert.equal(request?.args, "red");
  } finally {
    await recipient.dispose();
  }
});

test("a request addressed to another pane is refused by the recipient and never submitted", async () => {
  const recipient = await createStubRecipient({ pane: "w2:pSTUB" });
  try {
    const outcome = await deliverThroughExtension("for the sqd alpha only", 500, "w2:pOTHER", { socketPath: recipient.socketPath });
    assert.equal(outcome.kind, "refused");
    assert.deepEqual(recipient.submitted, []);
  } finally {
    await recipient.dispose();
  }
});

test("an answer that names another pane or another request is refused, never read as delivered", async () => {
  const socket = await socketAnswering((request) => JSON.stringify({ id: request.id, pane: "wrong-pane", status: "delivered", as: "turn" }));
  const otherRequest = await socketAnswering(() => JSON.stringify({ id: "message-99", pane: PANE, status: "delivered", as: "turn" }));
  try {
    const wrongPane = await deliverThroughExtension("hello", 500, PANE, { socketPath: socket.socketPath });
    assert.equal(wrongPane.kind, "refused");
    assert.match(wrongPane.kind === "refused" ? wrongPane.detail : "", /wrong-pane/u);
    assert.equal((await deliverThroughExtension("hello", 500, PANE, { socketPath: otherRequest.socketPath })).kind, "refused");
  } finally {
    await socket.dispose();
    await otherRequest.dispose();
  }
});

test("an unparseable or unknown answer is refused rather than assumed good", async () => {
  const garbled = await socketAnswering(() => "{ not json");
  const unknown = await socketAnswering((request) => JSON.stringify({ id: request.id, pane: PANE, status: "something-new" }));
  try {
    const first = await deliverThroughExtension("hello", 500, PANE, { socketPath: garbled.socketPath });
    assert.equal(first.kind, "refused");
    const second = await deliverThroughExtension("hello", 500, PANE, { socketPath: unknown.socketPath });
    assert.equal(second.kind, "refused");
    assert.match(second.kind === "refused" ? second.detail : "", /something-new/u);
  } finally {
    await garbled.dispose();
    await unknown.dispose();
  }
});

test("a recipient that answers busy is timed out", async () => {
  const socket = await socketAnswering((request) => JSON.stringify({ id: request.id, pane: PANE, status: "busy", reason: "draft" }));
  try {
    assert.equal((await deliverThroughExtension("hello", 500, PANE, { socketPath: socket.socketPath })).kind, "timed-out");
  } finally {
    await socket.dispose();
  }
});

test("no answer inside the wait and its margin is timed out, and the connection is closed so the recipient drops the request", async () => {
  const socket = await socketAnswering(() => undefined);
  try {
    const started = Date.now();
    const outcome = await deliverThroughExtension("hello", 100, PANE, { socketPath: socket.socketPath, requestId: "message-5" });
    assert.equal(outcome.kind, "timed-out");
    assert.ok(Date.now() - started >= 2_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(socket.closed, ["message-5"]);
  } finally {
    await socket.dispose();
  }
});

test("a recipient with no recorded socket, or a socket nobody listens on, is not answering", async () => {
  const folder = await mkdtemp(join(tmpdir(), "socket-missing-"));
  try {
    assert.equal((await deliverThroughExtension("hello", 500, PANE)).kind, "not-answering");
    assert.equal((await deliverThroughExtension("hello", 500, PANE, { socketPath: join(folder, "gone.sock") })).kind, "not-answering");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("an unaddressed delivery is refused, never broadcast", async () => {
  const recipient = await createStubRecipient({ pane: "" });
  try {
    const outcome = await deliverThroughExtension("nobody in particular", 500, "", { socketPath: recipient.socketPath });
    assert.equal(outcome.kind, "refused");
    assert.match(outcome.kind === "refused" ? outcome.detail : "", /recipient pane id/u);
    assert.deepEqual(recipient.requests, []);
  } finally {
    await recipient.dispose();
  }
});

test("a recipient answers alive only for its own pane, and a closed socket is not alive", async () => {
  const recipient = await createStubRecipient({ pane: PANE, commands: true });
  try {
    assert.deepEqual(await agentAlive(recipient.socketPath, PANE), { pane: PANE, harness: "claude", commands: true });
    assert.equal(await agentAlive(recipient.socketPath, "w9:pOTHER"), undefined);
    await recipient.stopListening();
    assert.equal(await agentAlive(recipient.socketPath, PANE), undefined);
    assert.equal(await agentAlive(undefined, PANE), undefined);
  } finally {
    await recipient.dispose();
  }
});
