import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { CronExpression, SchedulerRegistry } from "@nestjs/schedule";
import { CronJob } from "cron";
import { TransportClient } from "../transport/transport-client.ts";
import { buildProductionRouteHandlers } from "../throne-backend/transport-route-dispatcher.ts";
import { ALPHA_AUTOSCALE_HOSTED_WORKER_NAME } from "./alpha-autoscale.hosted-worker.ts";
import { acquireSweepLock } from "./alpha-autoscale-sweep-lock.ts";
import { showAutoscaleStatus } from "./autoscale-status.command.ts";
import {
  AUTOSCALE_STATUS_ROUTE_PATH,
  createAutoscaleStatusRouteHandler,
  renderAutoscaleStatusFrom,
} from "./autoscale-status-route.ts";
import { LOCAL_READING_BANNER, UNKNOWN_NEXT_RUN } from "./autoscale-status-render.ts";
import { buildAutoscaleStatusCourt, statusSourcesOver } from "./autoscale-status-test-fixtures.ts";

const court = buildAutoscaleStatusCourt();

function capturedOutput() {
  const written = { stdout: "", stderr: "" };
  return {
    written,
    sinks: {
      stdout: (text: string) => {
        written.stdout += text;
      },
      stderr: (text: string) => {
        written.stderr += text;
      },
    },
  };
}

test("an unreachable backend falls back to a local reading and says so first", async () => {
  const deadBackend = new TransportClient({
    socketPath: path.join(court.root, "no-backend.sock"),
    requestTimeoutMs: 2_000,
  });
  const { written, sinks } = capturedOutput();

  const exitCode = await showAutoscaleStatus([], deadBackend, statusSourcesOver(court), sinks);

  assert.equal(exitCode, 0);
  const lines = written.stdout.split("\n");
  assert.equal(lines[0], LOCAL_READING_BANNER);
  assert.equal(lines[1], "1. Autoscaler: running");
  assert.ok(lines.includes(`2. Next scheduled run: ${UNKNOWN_NEXT_RUN}`));
  assert.match(written.stderr, /^autoscale-status: could not reach throne-backend/);
});

test("the backend's status route reports the next five-minute tick from its schedule", async () => {
  const scheduler = new SchedulerRegistry();
  const job = new CronJob(CronExpression.EVERY_5_MINUTES, () => {});
  scheduler.addCronJob(ALPHA_AUTOSCALE_HOSTED_WORKER_NAME, job);
  const nextTick = job.nextDate().toJSDate();
  assert.ok(AUTOSCALE_STATUS_ROUTE_PATH in buildProductionRouteHandlers(scheduler));

  const result = await createAutoscaleStatusRouteHandler(scheduler, statusSourcesOver(court))({
    args: ["--json"],
  });

  assert.equal(result.exitCode, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.warning, null);
  assert.equal(report.viewpoint, "backend");
  assert.equal(report.nextRun.at, nextTick.toISOString());
  assert.ok(report.nextRun.inMs > 0 && report.nextRun.inMs <= 5 * 60_000);
});

test("a running sweep is reported without waiting for it", async () => {
  const acquisition = await acquireSweepLock({ lockPath: court.sweepLockPath });
  assert.equal(acquisition.outcome, "acquired");
  try {
    const startedAt = Date.now();
    const text = await renderAutoscaleStatusFrom(statusSourcesOver(court), []);
    assert.ok(Date.now() - startedAt < 5_000);
    assert.match(text, new RegExp(`^ {3}a sweep is running now \\(pid ${process.pid} on `, "m"));
  } finally {
    if (acquisition.outcome === "acquired") await acquisition.lease.release();
  }
});

test("a status route whose reading fails exits 1 with the error message on stderr", async () => {
  const result = await createAutoscaleStatusRouteHandler(undefined, {
    ...statusSourcesOver(court),
    inspectSweepLock: () => Promise.reject(new Error("sweep lock unreadable")),
  })({ args: [] });

  assert.deepEqual(result, { exitCode: 1, stdout: "", stderr: "sweep lock unreadable\n" });
});
