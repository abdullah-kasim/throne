import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:http";
import { DELIVERY_CALLBACK_ENV, DELIVERY_SOCKET_ENV } from "../shared/agent-delivery-contract.ts";
import throneDeliveryExtension from "./throne-pi-delivery.ts";

const PANE = "w1:pPI";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

type Handler = (event: unknown, context: unknown) => void;
type Sent = { text: string; options: unknown };

function stubPi(composer: { draft: string; idle: boolean; canSetDraft?: boolean }) {
  const handlers = new Map<string, Handler[]>();
  const sent: Sent[] = [];
  const logged: string[] = [];
  const draftWhenSent: string[] = [];
  const ui: Record<string, unknown> = { getEditorText: () => composer.draft };
  if (composer.canSetDraft) ui.setEditorText = (text: string) => (composer.draft = text);
  const context = { ui, isIdle: () => composer.idle };
  const emit = (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload, context);
  };
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendUserMessage: (text: string, options?: unknown) => {
      draftWhenSent.push(composer.draft);
      sent.push({ text, options });
    },
    logger: { debug: (line: string) => logged.push(line) },
  };
  return { pi, sent, logged, emit, draftWhenSent, seenAsUser: (text: string) => emit("message_start", { message: { role: "user", content: [{ type: "text", text }] } }) };
}

async function startExtension(stub: ReturnType<typeof stubPi>, callbackSocket?: string): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "pid-"));
  const socket = path.join(folder, "d.sock");
  const names = [DELIVERY_SOCKET_ENV, "HERDR_PANE_ID", DELIVERY_CALLBACK_ENV];
  const previous = names.map((name) => process.env[name]);
  process.env[DELIVERY_SOCKET_ENV] = socket;
  process.env.HERDR_PANE_ID = PANE;
  if (callbackSocket !== undefined) process.env[DELIVERY_CALLBACK_ENV] = callbackSocket;
  const listener = await throneDeliveryExtension(stub.pi);
  names.forEach((name, index) => restore(name, previous[index]));
  cleanups.push(async () => {
    await listener?.close();
    await rm(folder, { recursive: true, force: true });
  });
  stub.emit("session_start", {});
  return socket;
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function deliver(socket: string, id: string, text: string, waitMs: number, acknowledge?: true): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ socketPath: socket, method: "POST", path: "/deliver" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (piece: string) => (body += piece));
      response.on("end", () => resolve(JSON.parse(body)));
    });
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify({ id, pane: PANE, text, waitMs, acknowledge }));
  });
}

describe("the pi extension on its delivery socket", () => {
  test("it answers delivered only after its own message_start or turn_start event for that request is seen", async () => {
    const stub = stubPi({ draft: "", idle: true });
    const socket = await startExtension(stub);
    let answer: Record<string, unknown> | undefined;
    const pending = deliver(socket, "message-1", "hello pi", 3000).then((body) => (answer = body));
    await sleep(400);
    assert.deepEqual(stub.sent, [{ text: "hello pi", options: undefined }]);
    assert.equal(answer, undefined);
    stub.seenAsUser("hello pi");
    await pending;
    assert.deepEqual(answer, { id: "message-1", pane: PANE, status: "delivered", as: "turn" });
  });

  test("a message sent while a turn runs is queued as a followUp and answered delivered even when the turn outlasts the wait", async () => {
    const stub = stubPi({ draft: "", idle: false });
    const socket = await startExtension(stub);
    assert.deepEqual(await deliver(socket, "message-2", "after this turn", 700), { id: "message-2", pane: PANE, status: "delivered", as: "followUp" });
    assert.deepEqual(stub.sent, [{ text: "after this turn", options: { deliverAs: "followUp" } }]);
  });

  test("a message is held while a draft sits in the composer and nothing is sent", async () => {
    const stub = stubPi({ draft: "half typed", idle: true });
    const socket = await startExtension(stub);
    assert.deepEqual(await deliver(socket, "message-3", "wait for me", 700), { id: "message-3", pane: PANE, status: "busy", reason: "draft" });
    assert.deepEqual(stub.sent, []);
  });

  test("a pi agent with a draft accepts at once and delivers after restoring the draft or after the draft is gone", async () => {
    const callbacks: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      let text = "";
      request.setEncoding("utf8");
      request.on("data", (piece: string) => (text += piece));
      request.on("end", () => {
        callbacks.push(JSON.parse(text));
        response.writeHead(200, { connection: "close" });
        response.end();
      });
    });
    const backendFolder = await mkdtemp(path.join(tmpdir(), "pib-"));
    const address = path.join(backendFolder, "backend.sock");
    await new Promise<void>((resolve) => server.listen(address, () => resolve()));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(backendFolder, { recursive: true, force: true });
    });

    const restoringBox = { draft: "half typed", idle: false, canSetDraft: true };
    const restoring = stubPi(restoringBox);
    const restoringSocket = await startExtension(restoring, address);
    assert.deepEqual(await deliver(restoringSocket, "message-r", "around the draft", 60000, true), { id: "message-r", pane: PANE, status: "accepted" });
    const waitingBox = { draft: "half typed", idle: false };
    const waiting = stubPi(waitingBox);
    const waitingSocket = await startExtension(waiting, address);
    assert.deepEqual(await deliver(waitingSocket, "message-w", "after the draft", 60000, true), { id: "message-w", pane: PANE, status: "accepted" });

    for (let tries = 0; callbacks.length === 0 && tries < 100; tries += 1) await sleep(20);
    assert.deepEqual(restoring.sent, [{ text: "around the draft", options: { deliverAs: "followUp" } }]);
    assert.deepEqual(restoring.draftWhenSent, [""]);
    assert.equal(restoringBox.draft, "half typed");
    assert.deepEqual(waiting.sent, []);
    waitingBox.draft = "";
    for (let tries = 0; callbacks.length < 2 && tries < 100; tries += 1) await sleep(20);
    assert.deepEqual(waiting.sent, [{ text: "after the draft", options: { deliverAs: "followUp" } }]);
    assert.deepEqual(
      callbacks.map((callback) => [callback.id, callback.status, "token" in callback]),
      [["message-r", "delivered", false], ["message-w", "delivered", false]],
    );
  });

  test("with no socket in the environment it logs once and delivers nothing", async () => {
    const stub = stubPi({ draft: "", idle: true });
    const previous = process.env[DELIVERY_SOCKET_ENV];
    delete process.env[DELIVERY_SOCKET_ENV];
    const listener = await throneDeliveryExtension(stub.pi);
    restore(DELIVERY_SOCKET_ENV, previous);
    assert.equal(listener, undefined);
    assert.equal(stub.logged.length, 1);
    assert.match(stub.logged[0], /THRONE_DELIVERY_SOCKET or HERDR_PANE_ID is unset/);
  });
});
