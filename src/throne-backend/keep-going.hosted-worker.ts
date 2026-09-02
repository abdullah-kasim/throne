import { CronExpression } from "@nestjs/schedule";
import { Injectable, Optional } from "@nestjs/common";
import type { CronHostedWorker } from "./hosted-worker.types.ts";
import {
  run as runKeepGoing,
  type KeepGoingDependencies,
} from "../keep-going/keep-going.command.ts";
import { keepGoingExecutionGate } from "../keep-going/keep-going-route.ts";
import { sendSdNotify, type SdNotifyPayload } from "./sd-notify.ts";

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
 *
 * The one call site in this codebase that pings the systemd watchdog: a
 * completed tick proves the process is not wedged, whether that tick
 * succeeded or threw — a wedge is a tick that never returns at all, which
 * `WatchdogSec=` exists to catch. No other hosted worker pings the watchdog.
 *
 * The ping tolerates a bad TICK, never a bad WEEK: a consecutive-failure
 * counter resets to zero on every success, and a thrown tick still pings
 * while the counter sits below `CONSECUTIVE_FAILURE_THRESHOLD` — but once a
 * persistent failure (a broken dependency, a corrupted ledger, anything that
 * makes every tick throw) crosses that threshold, the ping is withheld so
 * `WatchdogSec=` can actually restart the service instead of being fed
 * forever by a wedged-in-substance-if-not-in-timing process.
 *
 * **Redis-independence, by construction.** This is the ONLY call site that
 * pings the watchdog, and `runOnce()` here is driven exclusively by the
 * `@nestjs/schedule` cron tick. Consequence: Redis cannot change
 * `throne-backend`'s crash-loop exposure — this tick keeps firing and keeps
 * pinging on the cron's own clock, unaware Redis exists at all.
 *
 * This worker's watchdog role is permanent: nothing else feeds
 * `WatchdogSec=4200`, so this worker is never removed; at most a future change
 * could make its sweep body conditional, never its watchdog ping.
 */
@Injectable()
export class KeepGoingHostedWorker implements CronHostedWorker {
  readonly kind = "cron" as const;
  readonly workerName = KEEP_GOING_HOSTED_WORKER_NAME;
  readonly cronExpression = CronExpression.EVERY_30_MINUTES;

  /**
   * Tolerates 2 consecutive failed ticks before withholding the ping on the
   * 3rd — enough to ride out a single flaky herdr call or a momentary
   * network blip (the transient case this threshold exists to protect)
   * without taking N so large that a genuinely broken/wedged-in-substance
   * process keeps lying to the watchdog for hours. See
   * `systemd/throne-backend.service`'s `WatchdogSec=` comment for the
   * matching detection-time arithmetic.
   */
  private static readonly CONSECUTIVE_FAILURE_THRESHOLD = 3;

  private consecutiveFailures = 0;

  constructor(
    @Optional() private readonly dependencies?: KeepGoingDependencies,
    @Optional() private readonly notifyWatchdog: (payload: SdNotifyPayload) => void = sendSdNotify,
  ) {}

  async runOnce(): Promise<void> {
    try {
      // Shared with the `keep-going` REST route handler's manual trigger --
      // see `keepGoingExecutionGate`'s doc comment for why the scheduled
      // tick and a manual poke must never run concurrently.
      await keepGoingExecutionGate.run(() => runKeepGoing([], this.dependencies));
      this.consecutiveFailures = 0;
      this.notifyWatchdog("WATCHDOG=1");
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures < KeepGoingHostedWorker.CONSECUTIVE_FAILURE_THRESHOLD) {
        this.notifyWatchdog("WATCHDOG=1");
      }
      throw error;
    }
  }
}
