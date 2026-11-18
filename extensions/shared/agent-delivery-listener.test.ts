import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_REQUEST_BYTES,
  type DeliveryRequest,
} from "./agent-delivery-contract.ts";
import { startDeliveryListener, type DeliveryListener, type SubmitAttempt, type TryDeliver } from "./agent-delivery-listener.ts";

const PANE = "w1:pTEST";
const folders: string[] = [];
const listeners: DeliveryListener[] = [];

afterEach(async () => {
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
