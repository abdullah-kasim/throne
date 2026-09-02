import { CronExpression } from "@nestjs/schedule";
import { Injectable } from "@nestjs/common";
import type { CronHostedWorker } from "./hosted-worker.types.ts";
import { THRONE_BACKEND_SERVICE_UNIT_NAME } from "../status/service-health.ts";
import { writeServiceGenerationMarkerSafely } from "../status/service-generation-marker.ts";

export const SERVICE_GENERATION_MARKER_REFRESH_WORKER_NAME = "service-generation-marker-refresh";

/**
 * Keeps `throne-backend`'s own service-generation marker current for the
 * life of the process, on top of the one-time stamp `ThroneBackendCommand`
 * already writes at startup. Backfills a marker for a process that started
 * before marker-stamping existed (or before some future change to it),
 * without the disruptive restart that was previously the only way such a
 * process picked one up.
 *
 * `startedAt` is captured once, at worker construction (effectively process
 * startup), and reused on every run -- only `generation` staying fixed
 * matters for `readServiceGenerationStaleness`, but reusing the real start
 * time keeps the field honest rather than drifting to "now" on every tick.
 * `writeServiceGenerationMarkerSafely` owns the write's failure isolation
 * (catch, log to stderr, continue) and the "same `moduleUrl` in, same
 * `generation` out" guarantee that keeps a refresh from ever re-resolving to
 * whatever build happens to be newest on disk.
 */
@Injectable()
export class ServiceGenerationMarkerRefreshHostedWorker implements CronHostedWorker {
  readonly kind = "cron" as const;
  readonly workerName = SERVICE_GENERATION_MARKER_REFRESH_WORKER_NAME;
  readonly cronExpression = CronExpression.EVERY_MINUTE;
  private readonly startedAt = new Date().toISOString();

  async runOnce(): Promise<void> {
    writeServiceGenerationMarkerSafely(
      THRONE_BACKEND_SERVICE_UNIT_NAME,
      import.meta.url,
      this.startedAt,
      process.pid,
    );
  }
}
