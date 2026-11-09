import "reflect-metadata";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");
const COMPILED_SOURCE = path.join(REPOSITORY_ROOT, "dist", "src");
const HEALTH_CHECK_ATTEMPTS = 50;
const HEALTH_CHECK_INTERVAL_MS = 20;
const INVALID_INVOCATION_EXIT_CODE = 2;
const FAKE_TAILSCALE = `#!/bin/sh
printf '%s\\n' "$*" >> "$(dirname "$0")/calls"
if [ "$1 $2" = "serve status" ]; then
  printf '{}'
fi
`;

const runCommand = promisify(execFile);

let scratch: string;

function compiledModule<Module>(relativePath: string): Promise<Module> {
  return import(pathToFileURL(path.join(COMPILED_SOURCE, relativePath)).href) as Promise<Module>;
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function healthAnswersAt(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < HEALTH_CHECK_ATTEMPTS; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => undefined);
    if (response?.ok === true) return true;
    await sleep(HEALTH_CHECK_INTERVAL_MS);
  }
  return false;
}

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "compiled-lazy-loading-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("the compiled web listener worker binds and answers", async () => {
  const { WebListenerHostedWorker } = await compiledModule<typeof import("./web-listener.hosted-worker.ts")>(
    "web-listener/web-listener.hosted-worker.js",
  );
  const port = await freeLoopbackPort();
  const logged: string[] = [];
  let stopRequested = false;
  const worker = new WebListenerHostedWorker({
    port,
    webRoot: scratch,
    log: (message) => logged.push(message),
  });

  const running = worker.start(() => stopRequested);
  const answered = await healthAnswersAt(port);
  stopRequested = true;
  await running;

  assert.deepEqual(logged, []);
  assert.equal(answered, true);
});

test("the compiled tailnet publishing worker reaches tailscale", async () => {
  const { TailnetPublishingHostedWorker } = await compiledModule<
    typeof import("./tailnet-publishing.hosted-worker.ts")
  >("web-listener/tailnet-publishing.hosted-worker.js");
  const tailscaleCommand = path.join(scratch, "tailscale");
  await writeFile(tailscaleCommand, FAKE_TAILSCALE);
  await chmod(tailscaleCommand, 0o755);
  const logged: string[] = [];

  await new TailnetPublishingHostedWorker({
    tailscaleCommand,
    ledgerPath: path.join(scratch, "state", "tailnet-routes.json"),
    listenerPort: 8431,
    configPath: path.join(scratch, "config.user.ts"),
    log: (message) => logged.push(message),
  }).runOnce();

  assert.deepEqual(logged, []);
  assert.match(await readFile(path.join(scratch, "calls"), "utf8"), /serve --bg --https=443 --set-path \/throne /);
});

test("the compiled preview command reaches its runtime", async () => {
  const attempt = runCommand(process.execPath, [path.join(COMPILED_SOURCE, "tools.js"), "preview"]);

  await assert.rejects(attempt, (error: { code: number; stderr: string }) => {
    assert.equal(error.code, INVALID_INVOCATION_EXIT_CODE, error.stderr);
    assert.match(error.stderr, /usage: throne preview add/);
    return true;
  });
});
