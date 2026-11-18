// The REST route (server side) and transport-triggering CLI helper (client
// side) that let `alpha-autoscale-tick` run its sweep inside the live
// `throne-backend` process instead of its own -- mirrors
// `src/keep-going/keep-going-route.ts`. `AlphaAutoscaleTickCommand` itself
// stays in `alpha-autoscale-tick.command.ts` and imports both from here.
import { TransportClient } from "../transport/transport-client.ts";
import {
  createCapturedSinks,
  runCapturedWork,
  runManualTriggerOverTransport,
  type ManualTriggerRouteResult,
} from "../transport/manual-trigger-route.ts";
import {
  AlphaAutoscaleHostedWorker,
  resolveAlphaAutoscaleDependencies,
} from "./alpha-autoscale.hosted-worker.ts";
import {
  SWEEP_LOCK_LATEST_EXPIRY_MS,
  SWEEP_LOCK_TIME_TO_LIVE_MS,
} from "./alpha-autoscale-sweep-lock.ts";

/**
 * This command's registered name on the transport route dispatcher.
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
  const captured = createCapturedSinks();
  const worker = new AlphaAutoscaleHostedWorker(
    resolveAlphaAutoscaleDependencies({
      log: (message) => captured.sinks.stdout(`${message}\n`),
    }),
  );
  const { bypass } = parseAlphaAutoscaleArgs(envelope.args);
  return runCapturedWork(captured, () => worker.runOnce({ bypassPressure: bypass }));
}

const TRANSPORT_FLAG = "--transport";
const LOCAL_FLAG = "--local";
const BYPASS_FLAG = "--bypass";
export const ALPHA_AUTOSCALE_DEFAULT_TRANSPORT = "rest";
export const ALPHA_AUTOSCALE_TRANSPORT_REQUEST_TIMEOUT_MS =
  SWEEP_LOCK_LATEST_EXPIRY_MS + SWEEP_LOCK_TIME_TO_LIVE_MS;

export function createAlphaAutoscaleTransportClient(socketPath?: string): TransportClient {
  return new TransportClient({
    socketPath,
    requestTimeoutMs: ALPHA_AUTOSCALE_TRANSPORT_REQUEST_TIMEOUT_MS,
  });
}

export interface ParsedAlphaAutoscaleArgs {
  readonly transport: string;
  readonly local: boolean;
  readonly bypass: boolean;
  readonly remainingArgs: string[];
}

/** Mirrors `parseKeepGoingArgs` (`src/keep-going/keep-going-route.ts`). */
export function parseAlphaAutoscaleArgs(args: readonly string[]): ParsedAlphaAutoscaleArgs {
  let transport: string | undefined;
  let local = false;
  let bypass = false;
  const remainingArgs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === LOCAL_FLAG) {
      local = true;
      continue;
    }
    if (argument === BYPASS_FLAG) {
      bypass = true;
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
  return { transport: transport ?? ALPHA_AUTOSCALE_DEFAULT_TRANSPORT, local, bypass, remainingArgs };
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
  process.stderr.write(
    "alpha-autoscale-tick: transport rest: running the sweep inside throne-backend " +
      "(--local runs it in this process instead)\n",
  );
  return runManualTriggerOverTransport(client, {
    commandName: "alpha-autoscale-tick",
    routePath: ALPHA_AUTOSCALE_ROUTE_PATH,
    args,
  });
}
