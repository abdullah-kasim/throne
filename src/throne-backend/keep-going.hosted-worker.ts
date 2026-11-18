import { CronExpression } from "@nestjs/schedule";
import { Injectable, Optional } from "@nestjs/common";
import type { CronHostedWorker } from "./hosted-worker.types.ts";
import {
  run as runKeepGoing,
  type KeepGoingDependencies,
} from "../keep-going/keep-going.command.ts";
import { keepGoingExecutionGate } from "../keep-going/keep-going-route.ts";

/**
 * Matches the standalone `throne-keep-going` systemd timer's 30-minute
 * cadence exactly, so hosting this in-process changes nothing about how
 * often the Regent heartbeat fires. The standalone timer stays installed
 * and enabled as an independent fallback — this worker does not replace it.
 */
export const KEEP_GOING_HOSTED_WORKER_NAME = "keep-going";

/**
 * Hosts the existing standalone `keep-going` command logic (`run`) as a
 * cron-scheduled in-process job. Reuses `run`'s own default dependency bag
 * — which resolves the target agent and Regent liveness fresh on every
 * call — so no herdr-server PID or agent identity is cached across ticks:
 * a server restart between two ticks is just two independent lookups.
 */
@Injectable()
export class KeepGoingHostedWorker implements CronHostedWorker {
  readonly kind = "cron" as const;
  readonly workerName = KEEP_GOING_HOSTED_WORKER_NAME;
  readonly cronExpression = CronExpression.EVERY_30_MINUTES;

  constructor(
    @Optional() private readonly dependencies?: KeepGoingDependencies,
  ) {}

  async runOnce(): Promise<void> {
    await keepGoingExecutionGate.run(() => runKeepGoing([], this.dependencies));
  }
}
