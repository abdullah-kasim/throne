import path from 'node:path';
import { RUNTIME_THRONE_ROOT } from '../shared-policy/runtime-throne-root.ts';
import { Command as CommanderCommand } from 'commander';
import { Inject, Optional } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { getAgentStatusesRoster } from '../agent-statuses/agent-statuses-roster.ts';
import { readAgentSupervisor } from '../agentdata/identity-data.service.ts';
import { resolveAgent, readAgent } from '../herdr/herdr-runtime.service.ts';
import { submitToAgentViaQueue } from '../throne-work/enqueue-heartbeat-message.ts';
import {
  clearBlockedMarker,
  readBlockedMarker,
  writeBlockedMarker,
} from '../agentdata/blocked-marker.service.ts';
import {
  agentRegistrationExists,
  fileExists,
  readSpawnSpec,
} from '../agentdata/spawn-data-contracts.ts';
import { isDurablyAccountedFor } from '../agentdata/ledger-data.service.ts';
import { hasProvenDelivery } from './proven-delivery.ts';
import {
  MessageQueueWorkItemState,
  openMessageQueueStore,
} from '../message-queue/message-queue.store.ts';
import { detectStaleThroneTabs, detectStrandedSpawns } from './stale-tab-report.ts';
import { recoverStrandedSpawn } from './stranded-spawn-recovery.ts';
import { ConfirmedObservationTracker } from './confirmed-observation.ts';
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';
import {
  runNoIdling,
  type NoIdlingDependencies,
  type RunNoIdlingOptions,
} from './no-idling-run.ts';
import { TransportClient, TransportConnectionError } from '../transport/transport-client.ts';
import { resolveTransportMode } from '../transport/resolve-transport-mode.ts';
import {
  AsyncSerialGate,
  createCapturedSinks,
  type ManualTriggerRouteResult,
} from '../transport/manual-trigger-route.ts';

const THRONE_ROOT = RUNTIME_THRONE_ROOT;

export const NO_IDLING_DEPENDENCIES = Symbol('NO_IDLING_DEPENDENCIES');

// A per-agent marker file, mirroring the ASSIGNMENT.md file-presence
// convention: its presence in an agent's ledger directory positively
// records that the agent is a receive-only canary, never meant to be
// assigned work, so no-idling must never flag it as stalled.
const IDLE_BY_DESIGN_MARKER_BASENAME = 'IDLE_BY_DESIGN';

async function hasFutureSqliteScheduledDelivery(name: string, nowMs: number): Promise<boolean> {
  const store = openMessageQueueStore();
  try {
    return store.listWorkItemsByStates([MessageQueueWorkItemState.Queued]).some((item) => {
      const payload = item.payload as { recipientName?: string };
      return item.dueAt !== null && item.dueAt > nowMs && payload.recipientName === name;
    });
  } finally {
    store.close();
  }
}

const hasFutureScheduledDelivery = hasFutureSqliteScheduledDelivery;

export const REAL_NO_IDLING_DEPENDENCIES: NoIdlingDependencies = {
  resolveLiveRoot: async () => THRONE_ROOT,
  getRoster: async () => getAgentStatusesRoster(),
  readAgentSupervisor,
  resolveAgent,
  // Regent notices route through the durable queue — a busy Regent composer
  // becomes a server-side retry instead of a failed sweep. See
  // `enqueue-heartbeat-message.ts`.
  submitToAgent: submitToAgentViaQueue,
  readAgent,
  blockedMarkerLedger: {
    readBlockedMarker: (name) => readBlockedMarker(name),
    writeBlockedMarker: (name, blockedBy) => writeBlockedMarker(name, { blockedBy }),
    clearBlockedMarker: (name) => clearBlockedMarker(name),
  },
  readSpawnSpec: (name, dataDir) => readSpawnSpec(name, dataDir),
  hasFutureScheduledDelivery,
  isIdleByDesign: (name, dataDir) =>
    fileExists(path.join(dataDir, name, IDLE_BY_DESIGN_MARKER_BASENAME)),
  detectStaleTabs: (dataDir) => detectStaleThroneTabs(undefined, dataDir),
  detectStrandedSpawns: (dataDir) => detectStrandedSpawns(undefined, dataDir),
  recoverStrandedSpawn: (agentName, classification, dataDir) =>
    recoverStrandedSpawn(agentName, classification, dataDir),
  checkCwdExists: (cwd) => fileExists(cwd),
  isDurablyAccountedFor: (name, dataDir) => isDurablyAccountedFor(name, dataDir),
  isRegisteredAgent: (name, dataDir) => agentRegistrationExists(name, dataDir),
  hasProvenDelivery: (name, dataDir) => hasProvenDelivery(name, dataDir),
  now: () => Date.now(),
  // Process-lifetime: the hosted worker and this route handler share this
  // exact dependency object across every scheduled/manual sweep, so one
  // tracker instance here carries each Alpha's fully-idle confirmation
  // streak across real, minute-apart samples (FP2's fix).
  fullyIdleFamilyLiveChildrenTracker: new ConfirmedObservationTracker(),
  excludedFamilyObservations: new Set<string>(),
};

export type { NoIdlingDependencies };

let productionDependencies: NoIdlingDependencies | undefined;

export function configureNoIdlingDependencies(
  dependencies: NoIdlingDependencies,
): void {
  productionDependencies = dependencies;
}

/** Mirrors `resolveKeepGoingDependencies` (`src/keep-going/keep-going.command.ts`). */
export function resolveNoIdlingDependencies(
  overrides: Partial<NoIdlingDependencies> = {},
): NoIdlingDependencies {
  return { ...(productionDependencies ?? REAL_NO_IDLING_DEPENDENCIES), ...overrides };
}

/** This command's registered name on the transport route dispatcher. */
export const NO_IDLING_ROUTE_PATH = 'no-idling';

const NOTIFY_FLAG = '--notify';

/**
 * Serializes every in-process invocation of the no-idling sweep -- both this
 * route handler's manual triggers AND `NoIdlingHostedWorker.runOnce()`'s
 * scheduled ticks -- so a REST-triggered manual run can never execute
 * concurrently with the cron tick of the SAME command. This matters far more
 * here than for `keep-going`: `no-idling` fires every MINUTE
 * (`CronExpression.EVERY_MINUTE`), so a manual trigger issued near a tick
 * boundary is a real, not theoretical, collision, and (unlike `keep-going`'s
 * plain nudge) an un-serialized overlap could double-fire real
 * `submitToAgent` notices to the same Alpha. Exported so the hosted worker
 * can import and share this exact instance.
 */
export const noIdlingExecutionGate = new AsyncSerialGate();

/**
 * The transport route dispatcher's handler for `no-idling`. Parses
 * `--notify` out of the wire args itself (the client already stripped
 * `--transport`/`--local` before sending) and defaults to report-only —
 * see `NoIdlingCommand`'s own `--notify` handling for the full reasoning.
 * Runs through `noIdlingExecutionGate` so it never overlaps the hosted
 * cron tick, and resolves dependencies through `resolveNoIdlingDependencies`
 * so a manual trigger observes the exact same production wiring the
 * scheduled tick uses.
 */
export async function handleNoIdlingRoute(envelope: {
  readonly args: readonly string[];
}): Promise<ManualTriggerRouteResult> {
  const notify = envelope.args.includes(NOTIFY_FLAG);
  return noIdlingExecutionGate.run(async () => {
    const { sinks, read } = createCapturedSinks();
    const exitCode = await runNoIdling(resolveNoIdlingDependencies(sinks), { notify });
    return { exitCode, ...read() };
  });
}

const TRANSPORT_FLAG = '--transport';
const LOCAL_FLAG = '--local';

interface ParsedNoIdlingArgs {
  readonly transport: string | undefined;
  readonly local: boolean;
  readonly notify: boolean;
}

function parseNoIdlingArgs(args: readonly string[]): ParsedNoIdlingArgs {
  let transport: string | undefined;
  let local = false;
  let notify = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === LOCAL_FLAG) {
      local = true;
      continue;
    }
    if (argument === NOTIFY_FLAG) {
      notify = true;
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
    // Every other flag is deliberately ignored here (`allowUnknownOptions`):
    // this command's own historical surface has no other flags.
  }
  return { transport, local, notify };
}

/**
 * Runs the sweep against the hosted `throne-backend` worker over the
 * transport. Never falls back to `--local` silently on failure -- a dead
 * backend is reported loudly with the `--local` remedy named -- and never
 * hangs: `TransportClient` bounds every request with a timeout.
 */
async function runNoIdlingOverTransport(
  client: TransportClient,
  args: readonly string[],
): Promise<number> {
  let response: Awaited<ReturnType<TransportClient['request']>>;
  try {
    response = await client.request(NO_IDLING_ROUTE_PATH, args);
  } catch (error) {
    if (error instanceof TransportConnectionError) {
      process.stderr.write(
        `no-idling: throne-backend is unreachable over the transport (${error.message}). ` +
          `Pass --local to run the in-process sweep instead.\n`,
      );
      return 1;
    }
    throw error;
  }
  if (!response.ok) {
    process.stderr.write(
      `no-idling: ${response.error?.message ?? 'transport request failed'}\n`,
    );
    return 1;
  }
  const result = response.result as ManualTriggerRouteResult;
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}

@Command({
  name: 'no-idling',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class NoIdlingCommand extends CommandRunner {
  private readonly transportClient: TransportClient;

  constructor(
    @Optional()
    @Inject(NO_IDLING_DEPENDENCIES)
    private readonly dependencies?: NoIdlingDependencies,
    @Optional() transportClient?: TransportClient,
  ) {
    super();
    this.transportClient = transportClient ?? new TransportClient();
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    let parsed: ParsedNoIdlingArgs;
    try {
      parsed = parseNoIdlingArgs(passedParams);
    } catch (error) {
      process.stderr.write(
        `no-idling: ${error instanceof Error ? error.message : String(error)}\n${renderEntranceRefusal({
          reason: "no-idling entrance validation rejected the supplied transport arguments.",
          bypass: undefined,
          supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
        })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const { transport, local, notify } = parsed;
    const mode = resolveTransportMode({ transport, local }, 'no-idling');
    if (mode === 'rest') {
      process.exitCode = await runNoIdlingOverTransport(
        this.transportClient,
        notify ? [NOTIFY_FLAG] : [],
      );
      return;
    }
    // `--local`'s default remains report-only too: since the standalone
    // `throne-no-idling` systemd timer was retired (KGR cutover), no live
    // caller depends on this command's own default sending real notices --
    // only `NoIdlingHostedWorker`'s scheduled tick does, and it calls
    // `runNoIdling` directly with `notify: true`, never through this
    // command. A CLI invocation (`--local` or bare) is, today, always a
    // human running a debugging tool -- and per the Lord's stated purpose
    // ("good for testing too"), that tool's default action must not be able
    // to spam every live Alpha in the court.
    const options: RunNoIdlingOptions = { notify };
    process.exitCode = await runNoIdling(
      productionDependencies ?? this.dependencies ?? REAL_NO_IDLING_DEPENDENCIES,
      options,
    );
  }
}
