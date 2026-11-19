import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { MIRRORED_CONTRACT } from "../extensions/claude/hooks/throne-delivery.ts";
import {
  DELIVERY_CALLBACK_ENV,
  DELIVERY_HELPER_ENV,
  DELIVERY_RUNTIME_ENV,
  DELIVERY_SOCKET_ENV,
  HELPER_LISTEN_TIMEOUT_MILLISECONDS,
  MOD_REPORT_TIMEOUT_MILLISECONDS,
  REMEMBERED_DELIVERED_IDS,
  RESULT_PATH,
} from "../extensions/shared/agent-delivery-contract.ts";

const PANE = "w1:pHELPER";
const helperScript = path.resolve(import.meta.dirname, "../extensions/claude/delivery-helper.ts");
const modScript = path.resolve(import.meta.dirname, "../extensions/claude/hooks/throne-delivery.ts");
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

type Helper = {
  socket: string;
  child: ChildProcessWithoutNullStreams;
  nextLine: () => Promise<Record<string, unknown>>;
  unread: Record<string, unknown>[];
};

async function startHelper(): Promise<Helper> {
  const folder = await mkdtemp(path.join(tmpdir(), "cdh-"));
  const socket = path.join(folder, "d.sock");
  const callbackSocket = path.join(folder, "callback.sock");
  const child = spawn(process.execPath, [helperScript], {
    env: { ...process.env, [DELIVERY_SOCKET_ENV]: socket, [DELIVERY_CALLBACK_ENV]: callbackSocket, HERDR_PANE_ID: PANE },
  });
  cleanups.push(async () => {
    child.kill();
    await rm(folder, { recursive: true, force: true });
  });
  const lines: Record<string, unknown>[] = [];
  const waiters: ((line: Record<string, unknown>) => void)[] = [];
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (piece: string) => {
    buffered += piece;
    let end = buffered.indexOf("\n");
    while (end !== -1) {
      const line = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      end = buffered.indexOf("\n");
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  const nextLine = () => {
    const line = lines.shift();
    return line ? Promise.resolve(line) : new Promise<Record<string, unknown>>((resolve) => waiters.push(resolve));
  };
  assert.deepEqual(await nextLine(), { listening: true });
  return { socket, child, nextLine, unread: lines };
}

function call(socket: string, method: string, url: string, body?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ socketPath: socket, method, path: url, signal }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (piece: string) => (text += piece));
      response.on("end", () => resolve(text === "" ? { status: response.statusCode } : JSON.parse(text)));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test("the helper passes a 20,000 character body with quotes, backslashes, newlines and emoji whole", async () => {
  const helper = await startHelper();
  const text = `"quoted" \\back\\slash\nnew line 🎉 `.repeat(800).slice(0, 20000);
  const answer = call(helper.socket, "POST", "/deliver", JSON.stringify({ id: "message-1", pane: PANE, text, waitMs: 3000 }));
  const line = await helper.nextLine();
  assert.deepEqual(line, { id: "message-1", text });
  await call(helper.socket, "POST", RESULT_PATH, JSON.stringify({ id: "message-1", status: "delivered", as: "turn" }));
  assert.deepEqual(await answer, { id: "message-1", pane: PANE, status: "delivered", as: "turn" });
});

test("a sender closing early produces the withdrawn line", async () => {
  const helper = await startHelper();
  const sender = new AbortController();
  const answer = call(helper.socket, "POST", "/deliver", JSON.stringify({ id: "message-2", pane: PANE, text: "hi", waitMs: 3000 }), sender.signal);
  assert.deepEqual(await helper.nextLine(), { id: "message-2", text: "hi" });
  sender.abort();
  await assert.rejects(answer);
  assert.deepEqual(await helper.nextLine(), { withdrawn: "message-2" });
});

test("a command request becomes a command line and the mod's report answers the sender", async () => {
  const helper = await startHelper();
  const answer = call(helper.socket, "POST", "/deliver", JSON.stringify({ id: "command-x", pane: PANE, command: "color", args: "green", waitMs: 3000 }));
  assert.deepEqual(await helper.nextLine(), { id: "command-x", command: "color", args: "green" });
  await call(helper.socket, "POST", RESULT_PATH, JSON.stringify({ id: "command-x", status: "refused", detail: "no such command" }));
  assert.deepEqual(await answer, { id: "command-x", pane: PANE, status: "refused", detail: "no such command" });
});

test("a silent mod ends busy and is asked once", { timeout: 15_000 }, async () => {
  const helper = await startHelper();
  const started = Date.now();
  const answer = call(helper.socket, "POST", "/deliver", JSON.stringify({ id: "command-silent", pane: PANE, command: "color", args: "green", waitMs: 10_000 }));
  assert.deepEqual(await helper.nextLine(), { id: "command-silent", command: "color", args: "green" });
  assert.deepEqual(await answer, { id: "command-silent", pane: PANE, status: "busy", reason: "composer-unreadable" });
  assert.ok(Date.now() - started < MOD_REPORT_TIMEOUT_MILLISECONDS + 2_000);
  assert.deepEqual(await helper.nextLine(), { withdrawn: "command-silent" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(helper.unread, []);
});

test("the helper answers GET /alive with harness claude, commands true and callbacks true", async () => {
  const helper = await startHelper();
  assert.deepEqual(await call(helper.socket, "GET", "/alive"), { pane: PANE, harness: "claude", commands: true, callbacks: true });
});

test("a request in flight when the helper dies comes back to the sender as a dropped connection", async () => {
  const helper = await startHelper();
  const answer = call(helper.socket, "POST", "/deliver", JSON.stringify({ id: "message-3", pane: PANE, text: "hi", waitMs: 3000 }));
  await helper.nextLine();
  helper.child.kill("SIGKILL");
  await assert.rejects(answer);
});

test("the mod's mirrored constants match the shared contract", async () => {
  assert.deepEqual(MIRRORED_CONTRACT, {
    resultPath: RESULT_PATH,
    helperListenTimeoutMilliseconds: HELPER_LISTEN_TIMEOUT_MILLISECONDS,
    rememberedStartedIds: REMEMBERED_DELIVERED_IDS,
  });
  const modSource = await readFile(modScript, "utf8");
  for (const name of [DELIVERY_SOCKET_ENV, DELIVERY_RUNTIME_ENV, DELIVERY_HELPER_ENV]) assert.ok(modSource.includes(`$.env.get('${name}')`), name);
});
