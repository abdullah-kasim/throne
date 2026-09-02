import { CronExpression } from "@nestjs/schedule";
import { Injectable, Optional } from "@nestjs/common";
import type { CronHostedWorker } from "./hosted-worker.types.ts";
import {
  REAL_NO_IDLING_DEPENDENCIES,
  noIdlingExecutionGate,
  type NoIdlingDependencies,
} from "../no-idling/no-idling.command.ts";
import { runNoIdling } from "../no-idling/no-idling-run.ts";

/** Matches the standalone `throne-no-idling` systemd timer's 1-minute cadence. */
export const NO_IDLING_HOSTED_WORKER_NAME = "no-idling";

/**
 * Hosts the existing standalone `no-idling` command logic (`runNoIdling`) as
 * a cron-scheduled in-process job, reusing the same real dependency bag the
 * standalone command defaults to.
 */
@Injectable()
export class NoIdlingHostedWorker implements CronHostedWorker {
  readonly kind = "cron" as const;
  readonly workerName = NO_IDLING_HOSTED_WORKER_NAME;
  readonly cronExpression = CronExpression.EVERY_MINUTE;

  constructor(
    @Optional()
    private readonly dependencies: NoIdlingDependencies = REAL_NO_IDLING_DEPENDENCIES,
  ) {}

  async runOnce(): Promise<void> {
    // Shared with the `no-idling` REST route handler's manual trigger -- see
    // `noIdlingExecutionGate`'s doc comment for why the scheduled tick and a
    // manual poke must never run concurrently (this command sends real
    // notices, unlike keep-going's plain nudge, so an overlap here can
    // double-notify an Alpha).
    await noIdlingExecutionGate.run(() =>
      runNoIdling(this.dependencies, { notify: true }),
    );
  }
}
