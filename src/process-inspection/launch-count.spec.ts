import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

import { startBackendVitals } from "./launch-count.ts";

test("the backend's minute line counts every child process launched in that minute", async () => {
  const readMinuteLine = startBackendVitals();
  await promisify(execFile)("true");
  spawnSync("true");
  await new Promise((resolve) => spawn("true").on("exit", resolve));
  assert.match(readMinuteLine(), /launches=3 /);
  assert.match(readMinuteLine(), /launches=0 /);
});

test("the backend's minute line reports resident memory and event-loop delay", async () => {
  const readMinuteLine = startBackendVitals();
  const blockUntil = Date.now() + 120;
  await new Promise((resolve) => setTimeout(resolve, 50));
  while (Date.now() < blockUntil) {}
  await new Promise((resolve) => setTimeout(resolve, 50));
  const match = /rss_mb=(\d+) loop_delay_ms mean=([\d.]+) p99=([\d.]+) max=([\d.]+)$/.exec(readMinuteLine());
  assert.ok(match);
  assert.ok(Number(match[1]) > 0);
  assert.ok(Number(match[4]) >= 50);
});
