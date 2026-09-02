/**
 * Shared machinery for exposing an existing in-process command's logic as a
 * REST-triggerable debugging route, reused by `keep-going` and `no-idling`
 * (`message-status` predates this and does not need it -- it has no
 * concurrent scheduled counterpart to race).
 */

export interface ManualTriggerRouteResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Two accumulating text sinks that stand in for `process.stdout`/`process.stderr` for the duration of one captured run. */
export interface CapturedSinks {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * Builds a fresh pair of accumulating sinks plus a reader for what they
 * collected. A fresh pair per invocation (never a shared/global buffer) is
 * what makes this safe under concurrency: two captured runs never write into
 * the same buffer, even when serialized behind the same `AsyncSerialGate`
 * they still each get their own sinks.
 */
export function createCapturedSinks(): {
  readonly sinks: CapturedSinks;
  readonly read: () => Pick<ManualTriggerRouteResult, "stdout" | "stderr">;
} {
  let stdout = "";
  let stderr = "";
  return {
    sinks: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    read: () => ({ stdout, stderr }),
  };
}

/**
 * Runs async work items one at a time in submission order, regardless of
 * which caller (a scheduled cron tick or a REST-triggered manual run)
 * submits them. Exists because `keep-going` and `no-idling` are each hosted
 * as a `CronHostedWorker` inside the SAME long-lived `throne-backend`
 * process that now also serves their REST route -- a manual trigger and the
 * next scheduled tick of the SAME command are two independent call sites
 * racing the same underlying sweep. `no-idling`'s 1-minute cadence makes
 * this a real, not theoretical, collision: a manual trigger issued near tick
 * boundary can otherwise run concurrently with the cron tick and double-fire
 * `submitToAgent` notices to the same Alpha. One gate instance per command
 * (never shared across commands) is threaded through both that command's
 * `runOnce()` and its route handler, so both call sites funnel through the
 * same serialization point.
 *
 * A queued item's failure never blocks the ones behind it -- each item's
 * settlement is independent of its neighbors', only their START order is
 * serialized.
 */
export class AsyncSerialGate {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const started = this.tail.then(work, work);
    // Swallow so one item's rejection doesn't poison the chain for the next
    // queued item; the caller of `run` still observes the real rejection via
    // the returned (unswallowed) promise.
    this.tail = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  }
}
