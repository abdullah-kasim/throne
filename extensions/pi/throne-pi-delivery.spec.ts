import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DELIVERY_SOCKET_ENV } from "../shared/agent-delivery-contract.ts";
import throneDeliveryExtension from "./throne-pi-delivery.ts";

const PANE = "w1:pPI";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

type Handler = (event: unknown, context: unknown) => void;
type Sent = { text: string; options: unknown };

function stubPi(composer: { draft: string; idle: boolean }) {
  const handlers = new Map<string, Handler[]>();
  const sent: Sent[] = [];
  const logged: string[] = [];
  const context = { ui: { getEditorText: () => composer.draft }, isIdle: () => composer.idle };
  const emit = (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload, context);
  };
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendUserMessage: (text: string, options?: unknown) => sent.push({ text, options }),
    logger: { debug: (line: string) => logged.push(line) },
  };
  return { pi, sent, logged, emit, seenAsUser: (text: string) => emit("message_start", { message: { role: "user", content: [{ type: "text", text }] } }) };
}

async function startExtension(stub: ReturnType<typeof stubPi>): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "pid-"));
  const socket = path.join(folder, "d.sock");
  const previous = { socket: process.env[DELIVERY_SOCKET_ENV], pane: process.env.HERDR_PANE_ID };
  process.env[DELIVERY_SOCKET_ENV] = socket;
  process.env.HERDR_PANE_ID = PANE;
  const listener = await throneDeliveryExtension(stub.pi);
  restore(DELIVERY_SOCKET_ENV, previous.socket);
  restore("HERDR_PANE_ID", previous.pane);
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

function deliver(socket: string, id: string, text: string, waitMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ socketPath: socket, method: "POST", path: "/deliver" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (piece: string) => (body += piece));
      response.on("end", () => resolve(JSON.parse(body)));
    });
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify({ id, pane: PANE, text, waitMs }));
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
