import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { postNtfyMessage, notifyConfigFrom } from "../notify-lord/notification.service.ts";
import { renderNtfyLine } from "./check-config.ts";

const INVENTED_TOPIC = "invented-topic-for-check-config";
const NTFY_DOC = "agent_docs/ntfy-phone-notifications.md";

async function configFileContaining(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "check-config-ntfy-"));
  const configPath = path.join(directory, "config.user.ts");
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  await writeFile(configPath, source);
  return configPath;
}

async function configFileWithNtfy(section: Record<string, unknown>): Promise<string> {
  return configFileContaining(`export default { ntfy: ${JSON.stringify(section)} };`);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startHealthyNtfyServer(): Promise<{ serverUrl: string; requestedPaths: string[]; close: () => void }> {
  const requestedPaths: string[] = [];
  const server = createServer((request, response) => {
    requestedPaths.push(request.url ?? "");
    response.writeHead(request.url === "/v1/health" ? 200 : 404).end('{"healthy":true}');
  });
  const serverUrl = await listen(server);
  return { serverUrl, requestedPaths, close: () => server.close() };
}

async function closedServerUrl(): Promise<string> {
  const server = createServer();
  const serverUrl = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return serverUrl;
}

async function postFailure(serverUrl: string): Promise<Error> {
  const config = { ...notifyConfigFrom({ serverUrl, topic: INVENTED_TOPIC }), timeoutMs: 2_000 };
  try {
    await postNtfyMessage("hello", config);
  } catch (error) {
    return error as Error;
  }
  return assert.fail("the post should have failed");
}

test("check-config says phone notifications are off and does not probe when sending is disabled", async () => {
  const ntfy = await startHealthyNtfyServer();
  try {
    for (const section of [{ enabled: false }, { serverUrl: ntfy.serverUrl, topic: INVENTED_TOPIC, enabled: false }]) {
      const report = await renderNtfyLine(await configFileWithNtfy(section));
      assert.equal(report.failed, false);
      assert.match(report.text, /^ntfy: phone notifications are off/);
      assert.equal(report.text.split("\n").filter(Boolean).length, 1);
    }
    assert.deepEqual(ntfy.requestedPaths, []);
  } finally {
    ntfy.close();
  }
});

test("check-config fails naming config.user.ts and the ntfy doc when the ntfy section is missing", async () => {
  for (const configPath of [
    await configFileContaining("export default { steering: {} };"),
    path.join(await mkdtemp(path.join(tmpdir(), "check-config-ntfy-")), "config.user.ts"),
  ]) {
    const report = await renderNtfyLine(configPath);
    assert.equal(report.failed, true);
    assert.ok(report.text.includes(configPath), report.text);
    assert.ok(report.text.includes(NTFY_DOC), report.text);
  }
});

test("check-config fails naming the server URL when the ntfy server does not answer", async () => {
  const serverUrl = await closedServerUrl();
  const startedAt = Date.now();

  const report = await renderNtfyLine(await configFileWithNtfy({ serverUrl, topic: INVENTED_TOPIC }));

  assert.equal(report.failed, true);
  assert.match(report.text, /FAILED/);
  assert.ok(report.text.includes(serverUrl), report.text);
  assert.ok(Date.now() - startedAt < 5_000);
});

test("check-config reports a healthy ntfy server by its URL", async () => {
  const ntfy = await startHealthyNtfyServer();
  try {
    const report = await renderNtfyLine(await configFileWithNtfy({ serverUrl: ntfy.serverUrl, topic: INVENTED_TOPIC }));

    assert.equal(report.failed, false);
    assert.doesNotMatch(report.text, /FAILED/);
    assert.ok(report.text.includes(ntfy.serverUrl), report.text);
    assert.deepEqual(ntfy.requestedPaths, ["/v1/health"]);
  } finally {
    ntfy.close();
  }
});

test("the ntfy topic never appears in check-config output or a post failure", async () => {
  const ntfy = await startHealthyNtfyServer();
  const closedUrl = await closedServerUrl();
  try {
    const outputs = [
      (await renderNtfyLine(await configFileWithNtfy({ topic: INVENTED_TOPIC, enabled: false }))).text,
      (await renderNtfyLine(await configFileWithNtfy({ serverUrl: closedUrl, topic: INVENTED_TOPIC }))).text,
      (await renderNtfyLine(await configFileWithNtfy({ serverUrl: ntfy.serverUrl, topic: INVENTED_TOPIC }))).text,
      (await postFailure(closedUrl)).message,
      (await postFailure(ntfy.serverUrl)).message,
    ];
    for (const output of outputs) {
      assert.ok(!output.includes(INVENTED_TOPIC), output);
    }
  } finally {
    ntfy.close();
  }
});
