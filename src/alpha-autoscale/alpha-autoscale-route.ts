// The REST route (server side) and transport-triggering CLI helper (client
// side) that let `alpha-autoscale-tick` run its sweep inside the live
// `throne-backend` process instead of its own -- mirrors
// `src/keep-going/keep-going-route.ts`. `AlphaAutoscaleTickCommand` itself
// stays in `alpha-autoscale-tick.command.ts` and imports both from here.
import { TransportClient, TransportConnectionError } from "../transport/transport-client.ts";
import {
  createCapturedSinks,
  type ManualTriggerRouteResult,
} from "../transport/manual-trigger-route.ts";
import {
  AlphaAutoscaleHostedWorker,
  resolveAlphaAutoscaleDependencies,
} from "./alpha-autoscale.hosted-worker.ts";

/**
 * This command's registered name on the transport route dispatcher.
 *
 * WATCHDOG FINDING (verified by grep over `sendSdNotify`/`notifyWatchdog`):
 * unlike `keep-going`, whose route deliberately calls its sweep's plain
 * `run()` instead of `runOnce()` so a manual trigger can never feed the
 * systemd watchdog on the scheduler's behalf, alpha-autoscale has no
 * watchdog feed anywhere in its call path to bypass. `sendSdNotify` has
 * exactly one call site in this codebase, `KeepGoingHostedWorker.runOnce()`
 * (`src/throne-backend/keep-going.hosted-worker.ts`); nothing in
 * `AlphaAutoscaleHostedWorker.runOnce()` or this route's call path ever
 * pings the watchdog. So this route calls `runOnce()` directly -- the same
 * method the cron tick calls -- rather than needing a separate
 * watchdog-avoiding entry point; there is none to invent.
 *
 * RESIDUAL BLIND SPOT (carried forward from `keep-going-route.ts`, restated
 * for alpha-autoscale's own watchdog-free reality): a manual trigger through
 * this route only proves the sweep logic runs -- it says nothing about
 * whether the cron scheduler itself is still ticking on its own. For
 * `keep-going` that blind spot is a deliberate trade against masking a dead
 * scheduler behind the watchdog; for alpha-autoscale there is no watchdog
 * wrapper being bypassed at all, so the blind spot is simply that this route
 * cannot observe the scheduler's own liveness, only the sweep's correctness.
 */
export const ALPHA_AUTOSCALE_ROUTE_PATH = "alpha-autoscale";

/**
 * The transport route dispatcher's handler for `alpha-autoscale`: constructs
 * a fresh `AlphaAutoscaleHostedWorker` over `resolveAlphaAutoscaleDependencies`
 * (the exact production wiring the scheduled tick uses), with only its `log` output
 * redirected into captured sinks, and calls `runOnce()` -- the exact method
 * the hosted cron provider calls. `runOnce()` itself funnels through
 * `alphaAutoscaleExecutionGate` (see that gate and `runOnce`'s own doc
 * comment), so this call is already serialized against the cron tick without
 * this handler needing to touch the gate directly. `runOnce()` returns
 * `void` and throws on failure rather than returning an exit code; this
 * handler decides exit-code semantics itself (0 on completion, 1 with the
 * error message captured to the stderr sink on a thrown error) since there
 * is no pre-existing exit-code convention here to preserve.
 */
export async function handleAlphaAutoscaleRoute(envelope: {
  readonly args: readonly string[];
}): Promise<ManualTriggerRouteResult> {
  const { sinks, read } = createCapturedSinks();
  const worker = new AlphaAutoscaleHostedWorker(
    resolveAlphaAutoscaleDependencies({
      log: (message) => sinks.stdout(`${message}\n`),
    }),
  );
  try {
    await worker.runOnce();
    return { exitCode: 0, ...read() };
  } catch (error) {
    sinks.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 1, ...read() };
  }
}

const TRANSPORT_FLAG = "--transport";
const LOCAL_FLAG = "--local";

export interface ParsedAlphaAutoscaleArgs {
  readonly transport: string | undefined;
  readonly local: boolean;
  readonly remainingArgs: string[];
}

/** Mirrors `parseKeepGoingArgs` (`src/keep-going/keep-going-route.ts`). */
export function parseAlphaAutoscaleArgs(args: readonly string[]): ParsedAlphaAutoscaleArgs {
  let transport: string | undefined;
  let local = false;
  const remainingArgs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === LOCAL_FLAG) {
      local = true;
      continue;
    }
    if (argument === TRANSPORT_FLAG) {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`${TRANSPORT_FLAG} needs a value`);
      }
      transport = value;
      index += 1;
      continue;
    }
    remainingArgs.push(argument);
  }
  return { transport, local, remainingArgs };
}

/**
 * Runs the sweep against the hosted `throne-backend` worker over the
 * transport. Never falls back to `--local` silently on failure -- a dead
 * backend is reported loudly with the `--local` remedy named -- and never
 * hangs: `TransportClient` bounds every request with a timeout. Mirrors
 * `runKeepGoingOverTransport`.
 */
export async function runAlphaAutoscaleOverTransport(
  client: TransportClient,
  args: readonly string[],
): Promise<number> {
  let response: Awaited<ReturnType<TransportClient["request"]>>;
  try {
    response = await client.request(ALPHA_AUTOSCALE_ROUTE_PATH, args);
  } catch (error) {
    if (error instanceof TransportConnectionError) {
      process.stderr.write(
        `alpha-autoscale-tick: throne-backend is unreachable over the transport (${error.message}). ` +
          `Pass --local to run the in-process sweep instead.\n`,
      );
      return 1;
    }
    throw error;
  }
  if (!response.ok) {
    process.stderr.write(
      `alpha-autoscale-tick: ${response.error?.message ?? "transport request failed"}\n`,
    );
    return 1;
  }
  const result = response.result as ManualTriggerRouteResult;
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}
