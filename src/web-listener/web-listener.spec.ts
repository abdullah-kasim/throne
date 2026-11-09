import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { SchedulerRegistry } from "@nestjs/schedule";
import { HostedWorkerRegistrarService } from "../throne-backend/hosted-worker-registrar.service.ts";
import { HOSTED_WORKERS } from "../throne-backend/hosted-worker.types.ts";
import { ThroneBackendModule } from "../throne-backend/throne-backend.module.ts";
import { healthResponse, type HealthResponse } from "../web-api-contract/health.ts";
import { TailnetPublishingHostedWorker } from "./tailnet-publishing.hosted-worker.ts";
import { validatedResponse } from "./validated-boundary.ts";
import { startWebListener } from "./web-listener-app.ts";
import { WEB_LISTENER_HOSTED_WORKER_NAME, WebListenerHostedWorker } from "./web-listener.hosted-worker.ts";

const APP_PAGE = "<!doctype html><title>invented app</title>";
const NEWER_APP_PAGE = "<!doctype html><title>newer invented app</title>";
const LARGE_SCRIPT = "export const invented = 1;\n".repeat(1000);

let scratch: string;
let listener: NestExpressApplication;
let address: string;

async function publishGeneration(name: string, page: string): Promise<void> {
  const generation = path.join(scratch, name);
  await mkdir(path.join(generation, "web", "assets"), { recursive: true });
  await writeFile(path.join(generation, "web", "index.html"), page);
  await writeFile(path.join(generation, "web", "assets", "app.js"), "export {};\n");
  await writeFile(path.join(generation, "web", "assets", "large.js"), LARGE_SCRIPT);
  await symlink(name, path.join(scratch, `${name}.publishing`));
  await rename(path.join(scratch, `${name}.publishing`), path.join(scratch, "dist"));
}

function boundAddress(): AddressInfo {
  return listener.getHttpServer().address() as AddressInfo;
}

function get(urlPath: string): Promise<Response> {
  return fetch(`${address}${urlPath}`, { redirect: "manual" });
}

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "web-listener-"));
  await publishGeneration("dist.build.first", APP_PAGE);
  listener = await startWebListener({ port: 0, webRoot: path.join(scratch, "dist", "web") });
  address = `http://127.0.0.1:${boundAddress().port}`;
});

after(async () => {
  await listener.close();
  await rm(scratch, { recursive: true, force: true });
});

test("the listener serves the built app and falls back to it for an app path", async () => {
  for (const urlPath of ["/", "/throne/", "/throne/where-i-stand/", "/where-i-stand"]) {
    const response = await get(urlPath);
    assert.equal(response.status, 200, urlPath);
    assert.equal(await response.text(), APP_PAGE, urlPath);
  }
});

test("the mount without its closing slash leads to the app", async () => {
  const response = await get("/throne");
  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), "/throne/");
});

test("the listener serves the built files at the root and under the mount", async () => {
  for (const urlPath of ["/assets/app.js", "/throne/assets/app.js"]) {
    const response = await get(urlPath);
    assert.equal(response.status, 200, urlPath);
    assert.equal(await response.text(), "export {};\n", urlPath);
  }
});

test("the built app is sent compressed when the browser accepts it", async () => {
  const response = await fetch(`${address}/throne/assets/large.js`, { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(response.headers.get("content-encoding"), "gzip");
  assert.equal(await response.text(), LARGE_SCRIPT);
});

test("the built app is sent plain to a browser that accepts no compression", async () => {
  const response = await fetch(`${address}/throne/assets/large.js`, { headers: { "Accept-Encoding": "identity" } });
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(await response.text(), LARGE_SCRIPT);
});

test("hashed asset files may be cached for good", async () => {
  for (const urlPath of ["/assets/app.js", "/throne/assets/app.js"]) {
    const response = await get(urlPath);
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable", urlPath);
  }
});

test("the web app's page may be restored by the browser and is still checked on every load", async () => {
  for (const urlPath of ["/", "/throne/", "/index.html", "/throne/where-i-stand/", "/where-i-stand"]) {
    const response = await get(urlPath);
    assert.equal(response.status, 200, urlPath);
    assert.equal(response.headers.get("cache-control"), "no-cache", urlPath);
  }
});

test("a hashed file that no longer exists is not kept for good as the index page", async () => {
  const response = await get("/throne/assets/gone-from-this-generation.js");
  assert.equal(response.headers.get("cache-control"), "no-cache");
});

test("api answers are checked with the server on every read", async () => {
  for (const urlPath of ["/api/health", "/throne/api/health", "/api/nothing-here"]) {
    const response = await get(urlPath);
    assert.equal(response.headers.get("cache-control"), "no-cache", urlPath);
  }
});

test("the listener answers health at the root and under the mount", async () => {
  for (const urlPath of ["/api/health", "/throne/api/health"]) {
    const response = await get(urlPath);
    assert.equal(response.status, 200, urlPath);
    assert.deepEqual(await response.json(), { ok: true });
  }
});

test("an unknown api path is a 404, not the app", async () => {
  for (const urlPath of ["/api/nothing-here", "/throne/api/nothing-here", "/api"]) {
    const response = await get(urlPath);
    assert.equal(response.status, 404, urlPath);
    assert.doesNotMatch(await response.text(), /invented app/, urlPath);
  }
});

test("a write to an app path is a 404, not the app", async () => {
  const response = await fetch(`${address}/throne/where-i-stand/`, { method: "POST" });
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /invented app/);
});

test("the listener binds to loopback only", () => {
  assert.equal(boundAddress().address, "127.0.0.1");
});

test("the old where-i-stand address redirects to the new page keeping its query", async () => {
  for (const [urlPath, location] of [
    ["/moved/where-i-stand", "/throne/where-i-stand/"],
    ["/moved/where-i-stand/", "/throne/where-i-stand/"],
    ["/moved/where-i-stand?from=phone&tab=epics", "/throne/where-i-stand/?from=phone&tab=epics"],
    ["/moved/where-i-stand/?from=phone", "/throne/where-i-stand/?from=phone"],
  ] as const) {
    const response = await get(urlPath);
    assert.equal(response.status, 302, urlPath);
    assert.equal(response.headers.get("location"), location, urlPath);
  }
});

test("a newly published generation is served with no restart", async () => {
  await publishGeneration("dist.build.second", NEWER_APP_PAGE);
  const response = await get("/throne/");
  assert.equal(await response.text(), NEWER_APP_PAGE);
  await publishGeneration("dist.build.third", APP_PAGE);
});

test("a response of the wrong shape fails at the boundary with the field named", () => {
  const wrongShape = { ok: false } as unknown as HealthResponse;
  assert.throws(
    () => validatedResponse(healthResponse, wrongShape),
    (error: Error & { getStatus(): number }) => {
      assert.match(error.message, /response does not match its contract: ok:/);
      assert.equal(error.getStatus(), 500);
      return true;
    },
  );
});

function occupyPort(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("a port that is already taken does not stop the backend", async () => {
  const occupied = await occupyPort();
  const takenPort = (occupied.address() as AddressInfo).port;
  const logged: string[] = [];
  const worker = new WebListenerHostedWorker({
    port: takenPort,
    webRoot: path.join(scratch, "dist", "web"),
    log: (message) => logged.push(message),
  });
  const registrar = new HostedWorkerRegistrarService([worker], new SchedulerRegistry());

  registrar.onApplicationBootstrap();
  await registrar.whenAllWorkersReady();
  await registrar.longLivedRuns.get(WEB_LISTENER_HOSTED_WORKER_NAME);
  await new Promise((resolve) => occupied.close(resolve));

  assert.equal(logged.length, 1);
  assert.match(logged[0]!, new RegExp(`not listening on port ${takenPort}: .*EADDRINUSE`));
});

test("the listener stops when the backend asks it to", async () => {
  const spare = await occupyPort();
  const sparePort = (spare.address() as AddressInfo).port;
  await new Promise((resolve) => spare.close(resolve));
  let stopRequested = false;
  const worker = new WebListenerHostedWorker({
    port: sparePort,
    webRoot: path.join(scratch, "dist", "web"),
    log: (message) => assert.fail(message),
  });

  const run = worker.start(() => stopRequested);
  await waitUntilAnswering(`http://127.0.0.1:${sparePort}/api/health`);
  stopRequested = true;
  await run;

  await assert.rejects(fetch(`http://127.0.0.1:${sparePort}/api/health`));
});

async function waitUntilAnswering(url: string): Promise<void> {
  for (;;) {
    const answered = await fetch(url).then(
      (response) => response.ok,
      () => false,
    );
    if (answered) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the backend hosts the web listener and the tailnet publisher", () => {
  const providers: { provide?: unknown; inject?: unknown[] }[] = Reflect.getMetadata("providers", ThroneBackendModule);
  const hostedWorkers = providers.find((provider) => provider.provide === HOSTED_WORKERS);
  assert.ok(hostedWorkers?.inject?.includes(WebListenerHostedWorker));
  assert.ok(hostedWorkers?.inject?.includes(TailnetPublishingHostedWorker));
});
