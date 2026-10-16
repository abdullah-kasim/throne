/**
 * Shared machinery for exposing an existing in-process command's logic as a
 * REST-triggerable debugging route, reused by `keep-going` and `no-idling`
 * (`message-status` predates this and does not need it -- it has no
 * concurrent scheduled counterpart to race).
 */

import {
  TransportConnectionError,
  type TransportClient,
} from "./transport-client.ts";

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

export async function runCapturedWork(
  captured: ReturnType<typeof createCapturedSinks>,
  work: () => Promise<void>,
): Promise<ManualTriggerRouteResult> {
  try {
    await work();
    return { exitCode: 0, ...captured.read() };
  } catch (error) {
    captured.sinks.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 1, ...captured.read() };
  }
}

export interface ManualTriggerOverTransport {
  readonly commandName: string;
  readonly routePath: string;
  readonly args: readonly string[];
}

export async function runManualTriggerOverTransport(
  client: TransportClient,
  trigger: ManualTriggerOverTransport,
): Promise<number> {
  let response: Awaited<ReturnType<TransportClient["request"]>>;
  try {
    response = await client.request(trigger.routePath, trigger.args);
  } catch (error) {
    if (error instanceof TransportConnectionError) {
      process.stderr.write(
        `${trigger.commandName}: throne-backend is unreachable over the transport (${error.message}). ` +
          `Pass --local to run the in-process sweep instead.\n`,
      );
      return 1;
    }
    throw error;
  }
  if (!response.ok) {
    process.stderr.write(
      `${trigger.commandName}: ${response.error?.message ?? "transport request failed"}. ` +
        `Pass --local to run the in-process sweep instead.\n`,
    );
    return 1;
  }
  const result = response.result as ManualTriggerRouteResult;
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
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
