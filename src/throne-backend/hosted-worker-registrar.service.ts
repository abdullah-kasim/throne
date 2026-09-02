import { Inject, Injectable, Optional, type OnApplicationBootstrap } from "@nestjs/common";
import { CronJob } from "cron";
import { spawn, type ChildProcess } from "node:child_process";
import { SchedulerRegistry } from "@nestjs/schedule";
import { HOSTED_WORKERS, type HostedWorker } from "./hosted-worker.types.ts";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How long `whenAllWorkersReady` waits for any single long-lived worker's
 * own `ready` promise before giving up on it by name. Independent of (and
 * deliberately well under) the systemd unit's `TimeoutStartSec=`: this
 * timeout exists so a hung worker produces an attributed, journal-visible
 * failure naming the culprit, rather than the process silently sitting
 * until systemd's own untargeted start-timeout kill with no diagnosis.
 */
const DEFAULT_WORKER_READY_TIMEOUT_MS = 20_000;

/**
 * Registers every hosted worker exactly once, at application bootstrap,
 * through the one uniform mechanism named by the semantic contract: a cron
 * worker's `runOnce` is wrapped in a real `CronJob` and added to Nest's
 * `SchedulerRegistry`; a long-lived worker's `start` is kicked off
 * immediately and tracked so the registrar can ask it to stop on shutdown.
 * Neither kind is special-cased beyond this one registration step — adding a
 * worker never touches this file's control flow, only `HOSTED_WORKERS`.
 */
@Injectable()
export class HostedWorkerRegistrarService implements OnApplicationBootstrap {
  private readonly stopFlags = new Map<string, boolean>();
  readonly longLivedRuns = new Map<string, Promise<void>>();
  readonly supervisedProcesses = new Map<string, ChildProcess>();
  private readonly readyPromisesByWorkerName = new Map<string, Promise<void>>();

  constructor(
    @Inject(HOSTED_WORKERS)
    private readonly workers: readonly HostedWorker[],
    private readonly schedulerRegistry: SchedulerRegistry,
    @Optional() private readonly workerReadyTimeoutMs: number = DEFAULT_WORKER_READY_TIMEOUT_MS,
  ) {}

  onApplicationBootstrap(): void {
    for (const worker of this.workers) {
      this.registerWorker(worker);
    }
  }

  private registerWorker(worker: HostedWorker): void {
    if (worker.kind === "cron") {
      this.registerCronWorker(worker);
    } else if (worker.kind === "long-lived") {
      this.registerLongLivedWorker(worker);
    } else {
      this.registerSupervisedProcessWorker(worker);
    }
  }

  private registerCronWorker(worker: CronHostedWorkerLocal): void {
    const job = new CronJob(worker.cronExpression, () => {
      worker.runOnce().catch((error: unknown) => {
        process.stderr.write(
          `throne-backend: hosted worker "${worker.workerName}" failed: ${errorText(error)}\n`,
        );
      });
    });
    this.schedulerRegistry.addCronJob(worker.workerName, job);
    job.start();
  }

  private registerLongLivedWorker(worker: LongLivedHostedWorkerLocal): void {
    this.stopFlags.set(worker.workerName, false);
    if (worker.ready) {
      this.readyPromisesByWorkerName.set(worker.workerName, worker.ready);
    }
    const run = worker
      .start(() => this.stopFlags.get(worker.workerName) === true)
      .catch((error: unknown) => {
        process.stderr.write(
          `throne-backend: hosted worker "${worker.workerName}" exited: ${errorText(error)}\n`,
        );
      });
    this.longLivedRuns.set(worker.workerName, run);
  }

  /**
   * Resolves once every long-lived worker that exposed its own `ready`
   * promise has reached it — never once every worker's entire lifetime.
   * Workers without a genuine readiness condition are not waited on at
   * all. Logs which workers it is waiting on before waiting (so a hang is
   * diagnosable while it's happening, not only after a timeout). All opted-in
   * readiness promises share one `workerReadyTimeoutMs` startup deadline,
   * whose timeout names every worker still pending. A worker rejection remains
   * an immediate, separately attributed failure.
   */
  async whenAllWorkersReady(): Promise<void> {
    if (this.readyPromisesByWorkerName.size === 0) {
      return;
    }
    process.stdout.write(
      `throne-backend: waiting for hosted workers to become ready: ${[
        ...this.readyPromisesByWorkerName.keys(),
      ].join(", ")}\n`,
    );
    const pendingWorkerNames = new Set(this.readyPromisesByWorkerName.keys());
    let timeout: NodeJS.Timeout | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(
          new Error(
            `throne-backend: hosted workers did not become ready within ` +
              `${this.workerReadyTimeoutMs}ms: ${[...pendingWorkerNames].join(", ")}`,
          ),
        );
      }, this.workerReadyTimeoutMs);
    });

    try {
      await Promise.race([
        Promise.all(
          [...this.readyPromisesByWorkerName.entries()].map(([workerName, ready]) =>
            this.awaitWorkerReady(workerName, ready, pendingWorkerNames),
          ),
        ),
        timeoutFailure,
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async awaitWorkerReady(
    workerName: string,
    ready: Promise<void>,
    pendingWorkerNames: Set<string>,
  ): Promise<void> {
    try {
      await ready;
      pendingWorkerNames.delete(workerName);
    } catch (error: unknown) {
      throw new Error(
        `throne-backend: hosted worker "${workerName}" failed before becoming ready: ${errorText(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Spawns the child process and tracks it. `worker.env` (which may hold
   * secrets a future relay reads from its own env file) is passed straight
   * through to `spawn`'s `env` option and never appears in any log line
   * this method writes — only the exit code/signal is logged.
   */
  private registerSupervisedProcessWorker(worker: SupervisedProcessHostedWorkerLocal): void {
    const child = spawn(worker.command, worker.args ? [...worker.args] : [], {
      env: worker.env === undefined ? process.env : { ...process.env, ...worker.env },
      stdio: "ignore",
    });
    child.on("exit", (code, signal) => {
      process.stdout.write(
        `throne-backend: supervised process worker "${worker.workerName}" exited (code=${code}, signal=${signal})\n`,
      );
    });
    this.supervisedProcesses.set(worker.workerName, child);
  }

  /**
   * Signals every long-lived worker's `shouldStop` hook and sends SIGTERM to
   * every supervised child process; cron jobs are stopped by closing the app.
   */
  requestStopAll(): void {
    for (const name of this.stopFlags.keys()) {
      this.stopFlags.set(name, true);
    }
    for (const child of this.supervisedProcesses.values()) {
      child.kill("SIGTERM");
    }
  }
}

// Local aliases keep the branch-handler signatures precise without
// re-importing the union type three times above.
type CronHostedWorkerLocal = Extract<HostedWorker, { kind: "cron" }>;
type LongLivedHostedWorkerLocal = Extract<HostedWorker, { kind: "long-lived" }>;
type SupervisedProcessHostedWorkerLocal = Extract<HostedWorker, { kind: "supervised-process" }>;
