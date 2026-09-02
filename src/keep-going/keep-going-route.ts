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
 *
 * ⚠️ DELIBERATELY DOES NOT FEED THE SYSTEMD WATCHDOG. `KeepGoingHostedWorker.runOnce()`
 * is the ONE call site in this codebase that pings `WATCHDOG=1`
 * (`throne-backend/keep-going.hosted-worker.ts`), and this route handler
 * calls `run()` directly instead of going through `runOnce()` -- it never
 * touches `notifyWatchdog` or the consecutive-failure counter. The watchdog's
 * question is "is the SCHEDULER (the cron tick) alive", not "did a sweep ever
 * run" -- if a human poking this debugging route also fed the watchdog, a
 * wedged/dead cron scheduler would stay hidden behind an operator's own
 * manual pokes, defeating the one mechanism built to catch that failure. A
 * manual trigger proves the SWEEP LOGIC works; it says nothing about whether
 * the SCHEDULER is still ticking on its own, so it must not be able to
 * satisfy the watchdog on the scheduler's behalf.
 *
 * ⚠️ RESIDUAL BLIND SPOT, stated plainly (Regent, 2026-08-13): because this
 * bypasses `runOnce()` entirely, a manual trigger ALSO never exercises
 * `runOnce()`'s own wrapper -- its consecutive-failure counter and the
 * WATCHDOG=1 ping logic that decides whether `WatchdogSec=` restarts a
 * wedged process (landed `ea38542`, threshold N=3, `WatchdogSec=4200`). If
 * THAT wrapper logic is itself broken, a manual trigger can never reveal it
 * -- it proves the sweep works, never that the scheduler's own
 * failure-tolerance machinery is intact. This is the accepted cost of not
 * masking a dead scheduler (see above), not an oversight -- but it means a
 * human debugging with this command cannot see everything the cron path
 * depends on. `KeepGoingCommand.run()` prints this same limitation to the
 * operator on every manual invocation so it is never buried in a doc
 * comment only the next agent reads.
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
 * `KeepGoingHostedWorker.runOnce()` calls before it pings the watchdog),
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
