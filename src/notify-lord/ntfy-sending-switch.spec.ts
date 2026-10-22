import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { IdentityLineReadStatus } from "../agentdata/identity-data.service.ts";
import { REAP_REASON } from "../agent-timings/reap-reason.ts";
import { validateNtfy } from "../shared-policy/ntfy-user-config.ts";
import {
  notifyAgentCompletion,
  postNtfyMessage,
  type FetchLike,
  type NotifyConfig,
  type NotifyDeps,
} from "./notification.service.ts";
import { runNotifyLord } from "./notify-lord.command.ts";

const invalid = (field: string, expectation: string): Error =>
  new Error(`${field} ${expectation}`);
const requireNonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`${field} must be a string`);
  return value;
};

function configWithSending(sendingEnabled: boolean): NotifyConfig {
  return {
    serverUrl: "http://127.0.0.1:9",
    topic: "invented-topic",
    timeoutMs: 1_000,
    notifyShadows: false,
    sendingEnabled,
  };
}

function recordingFetch(): { fetchImpl: FetchLike; requestedUrls: string[] } {
  const requestedUrls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    requestedUrls.push(url);
    return { ok: true, status: 200, text: async () => "" };
  };
  return { fetchImpl, requestedUrls };
}

function completionDeps(postedMessages: string[]): NotifyDeps {
  return {
    readAgentRole: async () => ({ status: IdentityLineReadStatus.Found, value: "Alpha" }),
    readAgentObjective: async () => "an invented objective",
    renderQueue: async () => "",
    postMessage: async (message) => {
      postedMessages.push(message);
    },
  };
}

test("the ntfy section accepts enabled as true or false", () => {
  assert.deepEqual(validateNtfy({ enabled: false }, invalid, requireNonEmptyString), { enabled: false });
  assert.deepEqual(
    validateNtfy({ serverUrl: "http://127.0.0.1:9", enabled: true }, invalid, requireNonEmptyString),
    { serverUrl: "http://127.0.0.1:9", enabled: true },
  );
});

test("the ntfy section refuses an enabled that is not true or false", () => {
  assert.throws(
    () => validateNtfy({ enabled: "no" }, invalid, requireNonEmptyString),
    /ntfy\.enabled must be true or false/,
  );
});

test("a post with sending turned off reaches no server", async () => {
  const { fetchImpl, requestedUrls } = recordingFetch();

  await postNtfyMessage("hello", configWithSending(false), { fetchImpl });

  assert.deepEqual(requestedUrls, []);
});

test("a post with sending turned on reaches the server", async () => {
  const { fetchImpl, requestedUrls } = recordingFetch();

  await postNtfyMessage("hello", configWithSending(true), { fetchImpl });

  assert.deepEqual(requestedUrls, ["http://127.0.0.1:9/invented-topic"]);
});

test("a completed Alpha sends no completion notice while sending is turned off", async () => {
  const postedMessages: string[] = [];

  const sent = await notifyAgentCompletion(
    "alpha-invented-01",
    REAP_REASON.COMPLETED,
    completionDeps(postedMessages),
    configWithSending(false),
  );

  assert.equal(sent, false);
  assert.deepEqual(postedMessages, []);
});

test("a completed Alpha sends its completion notice while sending is turned on", async () => {
  const postedMessages: string[] = [];

  const sent = await notifyAgentCompletion(
    "alpha-invented-01",
    REAP_REASON.COMPLETED,
    completionDeps(postedMessages),
    configWithSending(true),
  );

  assert.equal(sent, true);
  assert.equal(postedMessages.length, 1);
});

test("notify-lord says nothing was sent while sending is turned off", async () => {
  const postedMessages: string[] = [];
  const stdout: string[] = [];

  const exitCode = await runNotifyLord(["hello"], {
    postMessage: async (message) => {
      postedMessages.push(message);
    },
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => {},
    sendingEnabled: false,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(postedMessages, []);
  assert.match(stdout.join(""), /phone notifications are off .*nothing was sent/);
});

test("a completion notice that cannot be posted names the server it tried", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new Promise((resolve) => server.close(resolve));

  await assert.rejects(
    notifyAgentCompletion(
      "alpha-invented-01",
      REAP_REASON.COMPLETED,
      { ...completionDeps([]), postMessage: postNtfyMessage },
      { ...configWithSending(true), serverUrl },
    ),
    (error: Error) => {
      assert.equal(error.message, `ntfy POST to ${serverUrl} failed: fetch failed`);
      return true;
    },
  );
});
