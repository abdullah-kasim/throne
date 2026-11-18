import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { INestApplicationContext } from "@nestjs/common";
import {
  BACKEND_WATCHDOG_PING_INTERVAL_MS,
  createThroneBackendApp,
} from "./throne-backend-app.ts";

const SERVICE_UNIT_PATH = new URL("../../systemd/throne-backend.service", import.meta.url);
const LONGEST_SILENCE_BEFORE_RESTART_SECONDS = 150;

async function watchdogSecondsInServiceUnit(): Promise<number> {
  const unit = await readFile(SERVICE_UNIT_PATH, "utf8");
  const match = unit.match(/^WatchdogSec=(\d+)$/m);
  if (!match) throw new Error("systemd/throne-backend.service has no WatchdogSec= line");
  return Number(match[1]);
}

test("the backend app keeps feeding the systemd watchdog every 30 seconds once it is ready", async () => {
  const sent: string[] = [];
  const repeated: { fn: () => void; intervalMs: number }[] = [];
  let pingsStartedBeforeReady = 0;
  await createThroneBackendApp(
    async () => ({}) as INestApplicationContext,
    (payload) => sent.push(payload),
    async () => {
      pingsStartedBeforeReady = repeated.length;
    },
    () => {},
    (fn, intervalMs) => repeated.push({ fn, intervalMs }),
  );

  assert.equal(pingsStartedBeforeReady, 0);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0]!.intervalMs, 30_000);
  assert.deepEqual(sent, ["READY=1"]);
  repeated[0]!.fn();
  repeated[0]!.fn();
  assert.deepEqual(sent, ["READY=1", "WATCHDOG=1", "WATCHDOG=1"]);
});

test("the service unit's watchdog window catches a dead app process within about two minutes", async () => {
  const watchdogSeconds = await watchdogSecondsInServiceUnit();
  assert.ok(watchdogSeconds >= (3 * BACKEND_WATCHDOG_PING_INTERVAL_MS) / 1000);
  assert.ok(watchdogSeconds <= LONGEST_SILENCE_BEFORE_RESTART_SECONDS);
});
