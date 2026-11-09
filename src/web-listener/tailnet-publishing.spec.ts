import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CronExpression } from "@nestjs/schedule";
import { TailnetPublishingHostedWorker } from "./tailnet-publishing.hosted-worker.ts";

const LISTENER_PORT = 8431;
const HOST = "invented-host.example.ts.net";
const FAKE_TAILSCALE = `#!/bin/sh
printf '%s\\n' "$*" >> "$(dirname "$0")/calls"
if [ "$1 $2" = "serve status" ]; then
  cat "$(dirname "$0")/status.json"
fi
`;

let scratch: string;
let logged: string[];

function fakeTailscalePath(): string {
  return path.join(scratch, "tailscale");
}

function ledgerPath(): string {
  return path.join(scratch, "state", "tailnet-routes.json");
}

function workerUsing(tailscaleCommand: string): TailnetPublishingHostedWorker {
  return new TailnetPublishingHostedWorker({
    tailscaleCommand,
    ledgerPath: ledgerPath(),
    listenerPort: LISTENER_PORT,
    configPath: path.join(scratch, "config.user.ts"),
    log: (message) => logged.push(message),
  });
}

function tailnetHolding(handlers: Record<string, { Proxy: string }>): unknown {
  return { Web: { [`${HOST}:443`]: { Handlers: handlers } } };
}

async function tailnetShows(status: unknown): Promise<void> {
  await writeFile(path.join(scratch, "status.json"), JSON.stringify(status));
}

async function tailscaleCalls(): Promise<string[]> {
  const calls = await readFile(path.join(scratch, "calls"), "utf8");
  return calls.split("\n").filter((call) => call !== "");
}

async function publishingCalls(): Promise<string[]> {
  return (await tailscaleCalls()).filter((call) => call !== "serve status --json");
}

const THRONE_PUBLISH_CALL = `serve --bg --https=443 --set-path /throne http://127.0.0.1:${LISTENER_PORT}`;
const OLD_PAGE_PUBLISH_CALL =
  `serve --bg --https=443 --set-path /where-i-stand http://127.0.0.1:${LISTENER_PORT}/moved/where-i-stand`;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "tailnet-publishing-"));
  logged = [];
  await writeFile(fakeTailscalePath(), FAKE_TAILSCALE);
  await chmod(fakeTailscalePath(), 0o755);
  await tailnetShows({});
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("the tailnet publishes the app at /throne without funnel", async () => {
  await workerUsing(fakeTailscalePath()).runOnce();

  assert.deepEqual(await publishingCalls(), [THRONE_PUBLISH_CALL, OLD_PAGE_PUBLISH_CALL]);
  assert.equal((await tailscaleCalls()).some((call) => call.includes("funnel")), false);
  assert.deepEqual(logged, []);
});

test("what this code published is left as it is on the next run", async () => {
  const worker = workerUsing(fakeTailscalePath());
  await worker.runOnce();
  await tailnetShows(
    tailnetHolding({
      "/throne": { Proxy: `http://127.0.0.1:${LISTENER_PORT}` },
      "/where-i-stand": { Proxy: `http://127.0.0.1:${LISTENER_PORT}/moved/where-i-stand` },
    }),
  );

  await worker.runOnce();

  assert.deepEqual(await publishingCalls(), [THRONE_PUBLISH_CALL, OLD_PAGE_PUBLISH_CALL]);
  assert.deepEqual(logged, []);
});

test("a route this code published comes back after the tailnet loses it", async () => {
  const worker = workerUsing(fakeTailscalePath());
  await worker.runOnce();

  await worker.runOnce();

  assert.deepEqual(await publishingCalls(), [
    THRONE_PUBLISH_CALL,
    OLD_PAGE_PUBLISH_CALL,
    THRONE_PUBLISH_CALL,
    OLD_PAGE_PUBLISH_CALL,
  ]);
});

test("a route this code published follows a new listener port", async () => {
  const worker = workerUsing(fakeTailscalePath());
  await worker.runOnce();
  await tailnetShows(
    tailnetHolding({
      "/throne": { Proxy: "http://127.0.0.1:9999" },
      "/where-i-stand": { Proxy: `http://127.0.0.1:${LISTENER_PORT}/moved/where-i-stand` },
    }),
  );

  await worker.runOnce();

  assert.deepEqual(await publishingCalls(), [THRONE_PUBLISH_CALL, OLD_PAGE_PUBLISH_CALL, THRONE_PUBLISH_CALL]);
});

test("a tailnet path this code did not create is refused and left alone", async () => {
  await tailnetShows(tailnetHolding({ "/where-i-stand": { Proxy: "http://127.0.0.1:52000" } }));

  await workerUsing(fakeTailscalePath()).runOnce();

  assert.deepEqual(await publishingCalls(), [THRONE_PUBLISH_CALL]);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /refused \/where-i-stand on port 443: held by http:\/\/127\.0\.0\.1:52000/);
  const ledger: unknown = JSON.parse(await readFile(ledgerPath(), "utf8"));
  assert.deepEqual(ledger, { places: [{ httpsPort: 443, path: "/throne" }] });
});

test("the same path on another tailnet port does not block publishing", async () => {
  await tailnetShows({
    Web: { [`${HOST}:8443`]: { Handlers: { "/throne": { Proxy: "http://127.0.0.1:52000" } } } },
  });

  await workerUsing(fakeTailscalePath()).runOnce();

  assert.deepEqual(await publishingCalls(), [THRONE_PUBLISH_CALL, OLD_PAGE_PUBLISH_CALL]);
});

test("no tailscale on the machine is one log line, not a crash", async () => {
  await workerUsing(path.join(scratch, "no-such-tailscale")).runOnce();

  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /nothing published this run: .*ENOENT/);
});

test("a tailscale status of the wrong shape names the field and publishes nothing", async () => {
  await tailnetShows({ Web: { [`${HOST}:443`]: { Handlers: { "/throne": { Proxy: 7 } } } } });

  await workerUsing(fakeTailscalePath()).runOnce();

  assert.deepEqual(await publishingCalls(), []);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, new RegExp(`Web\\.${HOST.replaceAll(".", "\\.")}:443\\.Handlers\\./throne\\.Proxy:`));
});

test("a ledger of the wrong shape names the field and publishes nothing", async () => {
  const worker = workerUsing(fakeTailscalePath());
  await worker.runOnce();
  await writeFile(ledgerPath(), JSON.stringify({ places: [{ httpsPort: "443", path: "/throne" }] }));
  await tailnetShows({});

  await worker.runOnce();

  assert.deepEqual(await publishingCalls(), [THRONE_PUBLISH_CALL, OLD_PAGE_PUBLISH_CALL]);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /places\.0\.httpsPort:/);
});

test("the tailnet is reconciled at start and every minute", () => {
  const worker = workerUsing(fakeTailscalePath());
  assert.equal(worker.kind, "cron");
  assert.equal(worker.cronExpression, CronExpression.EVERY_MINUTE);
  assert.equal(worker.runsAtStart, true);
});
