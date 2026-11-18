// Split out of keep-going.command.ts to keep that file under the
// hand-authored 500-line limit (test/nest-commander-boundary.test.ts) --
// this holds the REST route (server side) and the transport-triggering CLI
// helper (client side); `KeepGoingCommand` itself stays in
// keep-going.command.ts and imports both from here.
import { TransportClient, TransportConnectionError } from '../transport/transport-client.ts';
import {
  AsyncSerialGate,
  createCapturedSinks,
  type ManualTriggerRouteResult,
} from '../transport/manual-trigger-route.ts';
import { run, resolveKeepGoingDependencies } from './keep-going-sweep.ts';

/**
 * This command's registered name on the transport route dispatcher.
 */
export const KEEP_GOING_ROUTE_PATH = 'keep-going';

/**
 * Serializes every in-process invocation of the keep-going sweep -- both this
 * route handler's manual triggers AND `KeepGoingHostedWorker.runOnce()`'s
 * scheduled ticks -- so a REST-triggered manual run can never execute
 * concurrently with the cron tick of the SAME command inside the same
 * `throne-backend` process. Exported so the hosted worker can import and
 * share this exact instance; a second gate instance would defeat the point.
 * Keep-going's 30-minute cadence makes an actual collision rare, but the
 * mechanism is applied uniformly with `no-idling` (whose 1-minute cadence
 * makes collision a real risk) rather than reasoned about per-command.
 */
export const keepGoingExecutionGate = new AsyncSerialGate();

/**
 * The transport route dispatcher's handler for `keep-going`: runs the exact
 * same `run()` the in-process command calls (which is also what
 * `KeepGoingHostedWorker.runOnce()` calls),
 * capturing what it would have written to stdout/stderr instead of writing
 * to `throne-backend`'s own process streams. Resolves dependencies through
 * `resolveKeepGoingDependencies` so a manual trigger observes the exact same
 * production wiring (herdr, queue, throttle, roster) the scheduled tick uses.
 */
export async function handleKeepGoingRoute(envelope: {
  readonly args: readonly string[];
}): Promise<ManualTriggerRouteResult> {
  return keepGoingExecutionGate.run(async () => {
    const { sinks, read } = createCapturedSinks();
    const exitCode = await run(
      [...envelope.args],
      resolveKeepGoingDependencies(sinks),
    );
    return { exitCode, ...read() };
  });
}

const TRANSPORT_FLAG = '--transport';
const LOCAL_FLAG = '--local';

interface ParsedKeepGoingArgs {
  readonly transport: string | undefined;
  readonly local: boolean;
  readonly remainingArgs: string[];
}

export function parseKeepGoingArgs(args: readonly string[]): ParsedKeepGoingArgs {
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
 * transport, printing whatever the real sweep printed. A dead/unreachable
 * backend fails loudly with a diagnosis and the `--local` remedy -- it never
 * falls back to the local sweep silently, because a silent fallback would
 * hide exactly the "backend is down" fact this debugging tool exists to
 * surface, and it never hangs: `TransportClient` bounds every request with
 * `DEFAULT_TRANSPORT_REQUEST_TIMEOUT_MS`.
 */
export async function runKeepGoingOverTransport(
  client: TransportClient,
  args: readonly string[],
): Promise<number> {
  let response: Awaited<ReturnType<TransportClient['request']>>;
  try {
    response = await client.request(KEEP_GOING_ROUTE_PATH, args);
  } catch (error) {
    if (error instanceof TransportConnectionError) {
      process.stderr.write(
        `keep-going: throne-backend is unreachable over the transport (${error.message}). ` +
          `Pass --local to run the in-process sweep instead.\n`,
      );
      return 1;
    }
    throw error;
  }
  if (!response.ok) {
    process.stderr.write(
      `keep-going: ${response.error?.message ?? 'transport request failed'}\n`,
    );
    return 1;
  }
  const result = response.result as ManualTriggerRouteResult;
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}
