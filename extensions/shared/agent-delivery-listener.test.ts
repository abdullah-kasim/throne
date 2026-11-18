import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_REQUEST_BYTES,
  type DeliveryRequest,
} from "./agent-delivery-contract.ts";
import {
  startDeliveryListener,
  type CallbackTarget,
  type DeliveryListener,
  type SubmitAttempt,
  type TryDeliver,
} from "./agent-delivery-listener.ts";

const PANE = "w1:pTEST";
const folders: string[] = [];
const listeners: DeliveryListener[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function socketPath(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "adl-"));
  folders.push(folder);
  return path.join(folder, "d.sock");
}

async function listen(socket: string, tryDeliver: TryDeliver): Promise<void> {
  listeners.push(await startDeliveryListener({ socketPath: socket, pane: PANE, harness: "pi", commands: true, tryDeliver }));
}

type Reply = { status: number; body: Record<string, unknown> };

function call(socket: string, method: string, url: string, body?: string, signal?: AbortSignal): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ socketPath: socket, method, path: url, signal }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (piece: string) => (text += piece));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text === "" ? {} : JSON.parse(text) }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function deliver(socket: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<Reply> {
  return call(socket, "POST", "/deliver", JSON.stringify(request), signal);
}

function recordingCallback(answers: (count: number) => SubmitAttempt) {
  const seen: DeliveryRequest[] = [];
  const signals: AbortSignal[] = [];
  const tryDeliver: TryDeliver = async (request, withdrawn) => {
    seen.push(request);
    signals.push(withdrawn);
    return answers(seen.length);
  };
  return { seen, signals, tryDeliver };
}

async function backend(statusCode = 200) {
  const callbacks: Record<string, unknown>[] = [];
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (piece: string) => (text += piece));
    request.on("end", () => {
      callbacks.push(JSON.parse(text));
      response.writeHead(statusCode, { connection: "close" });
      response.end();
    });
  });
  servers.push(server);
  const callbackSocket = path.join(path.dirname(await socketPath()), "backend.sock");
  await new Promise<void>((resolve) => server.listen(callbackSocket, () => resolve()));
  return { callbacks, socketPath: callbackSocket, paths };
}

async function listenWithCallback(socket: string, tryDeliver: TryDeliver, callback: CallbackTarget): Promise<void> {
  listeners.push(await startDeliveryListener({ socketPath: socket, pane: PANE, harness: "claude", commands: true, tryDeliver, callback }));
}

async function until(condition: () => boolean, milliseconds = 3000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!condition() && Date.now() < deadline) await sleep(10);
}

describe("the listener with a callback address", () => {
  test("a message sent to a busy agent that asked for an acknowledgement is accepted at once", async () => {
    const socket = await socketPath();
    const server = await backend();
    let busy = true;
    const callback = recordingCallback(() => (busy ? { status: "not-yet", reason: "draft" } : { status: "delivered", as: "turn" }));
    await listenWithCallback(socket, callback.tryDeliver, { socketPath: server.socketPath });
    const started = Date.now();
    const reply = await deliver(socket, { id: "message-a", pane: PANE, text: "hi", waitMs: 60000, acknowledge: true });
    assert.deepEqual(reply.body, { id: "message-a", pane: PANE, status: "accepted" });
    assert.ok(Date.now() - started < 1000);
    busy = false;
    await until(() => server.callbacks.length === 1);
    assert.deepEqual(server.callbacks, [{ id: "message-a", pane: PANE, status: "delivered", as: "turn" }]);
    assert.deepEqual(server.paths, ["/api/delivery-callback"]);
  });

  test("accepted messages reach the harness in the order they arrived", async () => {
    const socket = await socketPath();
    const server = await backend();
    const taken: string[] = [];
    const tryDeliver: TryDeliver = async (request) => {
      await sleep(request.id === "message-1" ? 150 : 10);
      taken.push(request.id);
      return { status: "delivered", as: "turn" };
    };
    await listenWithCallback(socket, tryDeliver, { socketPath: server.socketPath });
    for (const id of ["message-1", "message-2", "message-3"]) {
      await deliver(socket, { id, pane: PANE, text: id, waitMs: 60000, acknowledge: true });
    }
    await until(() => server.callbacks.length === 3);
    assert.deepEqual(taken, ["message-1", "message-2", "message-3"]);
    assert.deepEqual(server.callbacks.map((callback) => callback.id), ["message-1", "message-2", "message-3"]);
  });

  test("the backend is told once that an accepted message was delivered", async () => {
    const socket = await socketPath();
    const server = await backend();
    const callback = recordingCallback(() => ({ status: "delivered", as: "followUp" }));
    await listenWithCallback(socket, callback.tryDeliver, { socketPath: server.socketPath });
    await deliver(socket, { id: "message-once", pane: PANE, text: "hi", waitMs: 60000, acknowledge: true });
    await until(() => server.callbacks.length === 1);
    await sleep(300);
    assert.deepEqual(server.callbacks, [{ id: "message-once", pane: PANE, status: "delivered", as: "followUp" }]);
  });

  test("a callback the backend cannot receive is retried for two minutes and then dropped", async () => {
    const socket = await socketPath();
    const server = await backend(500);
    const callback = recordingCallback(() => ({ status: "refused", detail: "submit dropped" }));
    await listenWithCallback(socket, callback.tryDeliver, {
      socketPath: server.socketPath,
      retryIntervalMilliseconds: 50,
      retryWindowMilliseconds: 400,
    });
    await deliver(socket, { id: "message-lost", pane: PANE, text: "hi", waitMs: 60000, acknowledge: true });
    await sleep(700);
    const attempts = server.callbacks.length;
    assert.ok(attempts >= 5 && attempts <= 9, `${attempts} attempts`);
    await sleep(300);
    assert.equal(server.callbacks.length, attempts);
    assert.deepEqual(server.callbacks[0], { id: "message-lost", pane: PANE, status: "refused", detail: "submit dropped" });
  });

  test("a message already delivered is answered delivered as a repeat and not submitted again", async () => {
    const socket = await socketPath();
    const server = await backend();
    const callback = recordingCallback(() => ({ status: "delivered", as: "turn" }));
    await listenWithCallback(socket, callback.tryDeliver, { socketPath: server.socketPath });
    const request = { id: "message-again", pane: PANE, text: "hi", waitMs: 60000, acknowledge: true };
    await deliver(socket, request);
    await until(() => server.callbacks.length === 1);
    const second = await deliver(socket, request);
    assert.deepEqual(second.body, { id: "message-again", pane: PANE, status: "delivered", as: "turn", repeat: true });
    assert.equal(callback.seen.length, 1);
  });

  test("a sender that did not ask for an acknowledgement is held as before", async () => {
    const socket = await socketPath();
    const server = await backend();
    const callback = recordingCallback(() => ({ status: "delivered", as: "turn" }));
    await listenWithCallback(socket, callback.tryDeliver, { socketPath: server.socketPath });
    const reply = await deliver(socket, { id: "message-held", pane: PANE, text: "hi", waitMs: 1000 });
    assert.deepEqual(reply.body, { id: "message-held", pane: PANE, status: "delivered", as: "turn" });
    await sleep(200);
    assert.deepEqual(server.callbacks, []);
  });

  test("GET /alive answers callbacks true when a callback address and token are given", async () => {
    const socket = await socketPath();
    const server = await backend();
    await listenWithCallback(socket, recordingCallback(() => ({ status: "delivered", as: "turn" })).tryDeliver, { socketPath: server.socketPath });
    const alive = await call(socket, "GET", "/alive");
    assert.deepEqual(alive.body, { pane: PANE, harness: "claude", commands: true, callbacks: true });
  });
});

describe("the shared agent delivery listener", () => {
  test("a message the harness takes is answered delivered with its text whole", async () => {
    const socket = await socketPath();
    const callback = recordingCallback(() => ({ status: "delivered", as: "turn" }));
    await listen(socket, callback.tryDeliver);
    const text = `quote " backslash \\ newline \n emoji 🐉 `.repeat(500).slice(0, 20000);
    const reply = await deliver(socket, { id: "message-1", pane: PANE, text, waitMs: 1000 });
    assert.deepEqual(reply.body, { id: "message-1", pane: PANE, status: "delivered", as: "turn" });
    assert.deepEqual(callback.seen.map((request) => (request as { text: string }).text), [text]);
  });

  test("a request addressed to another pane is refused and nothing is submitted", async () => {
    const socket = await socketPath();
    const callback = recordingCallback(() => ({ status: "delivered", as: "turn" }));
    await listen(socket, callback.tryDeliver);
    const reply = await deliver(socket, { id: "message-2", pane: "w1:pOTHER", text: "hi", waitMs: 1000 });
    assert.equal(reply.body.status, "refused");
    assert.deepEqual(callback.seen, []);
  });

  test("a malformed request is refused and nothing is submitted", async () => {
    const socket = await socketPath();
    const callback = recordingCallback(() => ({ status: "delivered", as: "turn" }));
    await listen(socket, callback.tryDeliver);
    const reply = await call(socket, "POST", "/deliver", "{not json");
    assert.equal(reply.body.status, "refused");
    assert.deepEqual(callback.seen, []);
  });

  test("an id already delivered is answered delivered with repeat true and nothing is resubmitted", async () => {
    const socket = await socketPath();
    const callback = recordingCallback(() => ({ status: "delivered", as: "followUp" }));
    await listen(socket, callback.tryDeliver);
    const request = { id: "command-7f3a", pane: PANE, command: "color", args: "green", waitMs: 0 };
    await deliver(socket, request);
    const second = await deliver(socket, request);
    assert.deepEqual(second.body, { id: "command-7f3a", pane: PANE, status: "delivered", as: "followUp", repeat: true });
    assert.equal(callback.seen.length, 1);
  });

  test("a request the harness cannot take within waitMs is answered busy with the last reason and never submitted after", async () => {
    const socket = await socketPath();
    const callback = recordingCallback((count) => (count < 2 ? { status: "not-yet", reason: "turn-running" } : { status: "not-yet", reason: "draft" }));
    await listen(socket, callback.tryDeliver);
    const started = Date.now();
    const reply = await deliver(socket, { id: "message-3", pane: PANE, text: "hi", waitMs: 800 });
    const elapsed = Date.now() - started;
    assert.deepEqual(reply.body, { id: "message-3", pane: PANE, status: "busy", reason: "draft" });
    assert.ok(elapsed >= 500);
    assert.ok(elapsed < 1500);
    const attemptsAtAnswer = callback.seen.length;
    assert.equal(callback.signals.every((signal) => signal.aborted), true);
    await sleep(600);
    assert.equal(callback.seen.length, attemptsAtAnswer);
  });

  test("a request body over 1 MB is refused and nothing is submitted", async () => {
    const socket = await socketPath();
    const callback = recordingCallback(() => ({ status: "delivered", as: "turn" }));
    await listen(socket, callback.tryDeliver);
    let outcome = "connection-closed";
    try {
      const reply = await deliver(socket, { id: "message-4", pane: PANE, text: "x".repeat(MAX_REQUEST_BYTES + 1), waitMs: 1000 });
      outcome = reply.body.status as string;
    } catch {
      outcome = "connection-closed";
    }
    assert.ok(["refused", "connection-closed"].includes(outcome));
    assert.deepEqual(callback.seen, []);
  });

  test("the sender closing the connection early withdraws the request and the callback learns of it", async () => {
    const socket = await socketPath();
    const callback = recordingCallback(() => ({ status: "not-yet", reason: "draft" }));
    await listen(socket, callback.tryDeliver);
    const sender = new AbortController();
    const pending = (async () => {
      try {
        await deliver(socket, { id: "message-5", pane: PANE, text: "hi", waitMs: 5000 }, sender.signal);
      } catch {
        return "closed";
      }
      return "answered";
    })();
    while (callback.seen.length === 0) await sleep(10);
    sender.abort();
    await pending;
    const deadline = Date.now() + 2000;
    while (!callback.signals[0]!.aborted && Date.now() < deadline) await sleep(10);
    assert.equal(callback.signals[0]!.aborted, true);
    const attemptsAtWithdrawal = callback.seen.length;
    await sleep(600);
    assert.equal(callback.seen.length, attemptsAtWithdrawal);
  });

  test("a stale socket file is removed before listening and is not mistaken for alive", async () => {
    const socket = await socketPath();
    const dead = spawn(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(process.argv[1], () => console.log("up"))`,
      socket,
    ]);
    await new Promise<void>((resolve) => dead.stdout.once("data", () => resolve()));
    dead.kill("SIGKILL");
    await new Promise<void>((resolve) => dead.once("exit", () => resolve()));
    assert.ok((await stat(socket)).isSocket());
    await assert.rejects(call(socket, "GET", "/alive"));
    const callback = recordingCallback(() => ({ status: "delivered", as: "turn" }));
    await listen(socket, callback.tryDeliver);
    const alive = await call(socket, "GET", "/alive");
    assert.equal(alive.body.pane, PANE);
  });

  test("GET /alive answers the pane, harness and commands given at start", async () => {
    const socket = await socketPath();
    listeners.push(
      await startDeliveryListener({
        socketPath: socket,
        pane: PANE,
        harness: "claude",
        commands: true,
        tryDeliver: async () => ({ status: "delivered", as: "turn" }),
      }),
    );
    const alive = await call(socket, "GET", "/alive");
    assert.deepEqual(alive.body, { pane: PANE, harness: "claude", commands: true });
  });
});
