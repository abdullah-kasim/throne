// Background heartbeat AND self-healing watchdog for the throne Regent.
//
// The systemd timer fires this every 30 min regardless of any live harness, so
// it is the court's IMMORTAL watchdog. What it does is gated on the Regent's
// declarative DESIRED STATE (see regentstate.ts) — the systemd enable/disable
// model, chosen because the MANNER of a Regent's death is undetectable:
//   - `dismissed`          → do NOTHING (the Lord stood the court down).
//   - `running` + live     → nudge the Regent to work the queue (the heartbeat).
//   - `running` + no live  → RESURRECT a fresh Regent (the self-heal).
// An explicit `--name <agent>` bypasses ALL of this and simply nudges that one
// named agent (e.g. a specific Alpha) — never resurrecting.
//
// Reliability rule: every path resolves its target by UNIQUE NAME and verifies
// exactly one match before sending — a missing/ambiguous target is a logged
// no-op, never a misfire at the wrong harness. See AGENTS.md, "The reliability
// rule".
//
// Split out of keep-going.command.ts (which now holds only the Nest
// CommandRunner class) to keep both files under the hand-authored 500-line
// limit (test/nest-commander-boundary.test.ts) and, just as importantly, to
// avoid a keep-going.command.ts <-> keep-going-route.ts import cycle: this
// file is the shared base both depend on, and depends on neither.
//
// Owns the one call site that submits an agent prompt directly
// (`deps.submitToAgent`) so that responsibility stays traceable to a single
// file; `keep-going-nudge.ts` and `keep-going-regent-tending.ts` decide
// *what*/*whether* to nudge and hand the target back here to send.

import { resolveAgent } from '../herdr/herdr-runtime.service.ts';
import { submitToAgentViaQueue } from '../throne-work/enqueue-heartbeat-message.ts';
import { enqueueRegentResurrection } from '../throne-work/regent-resurrection.ts';
import { getAgentStatusesRoster } from '../agent-statuses/agent-statuses-roster.ts';
import {
  findLiveRegent,
  readDesiredState,
} from '../regent-state/regent-state.service.ts';
import { ThrottleSteeringService } from '../shared-policy/throttle-steering.service.ts';
import { RUNTIME_THRONE_ROOT } from '../shared-policy/runtime-throne-root.ts';
import {
  formatCapacityPressureReportLine,
  readCapacityPressure,
} from './keep-going-pressure-report.ts';
import {
  countUnlaunchedQueueItems,
  formatQueueBacklogReportLine,
} from './keep-going-backlog-report.ts';
import { renderKeepGoingEligibilityDepthReport } from './keep-going-eligibility-depth-report.ts';
import { readStallEvidence, type FamilyRecoverySummary } from './keep-going-stalls.ts';
import type { SubmitToAgentOptions } from '../herdr/herdr-send.types.ts';
import { runRegentFenceOrchestration } from '../regent-fencing/run-regent-fence-orchestration.ts';
import type { HerdrAgent, KeepGoingDependencies, ThrottleBand } from './keep-going-context.ts';
import {
  errText,
  GENERAL_NUDGE_TEXT,
  REGENT_NAME,
  sameAgentName,
  UNTHROTTLED_EVALUATION,
  writeErr,
  writeOut,
} from './keep-going-context.ts';
import {
  buildRegentNudgeText,
  keepGoingWindowKey,
} from './keep-going-nudge.ts';
import { evaluateRegentFenceReal, tendRegent } from './keep-going-regent-tending.ts';

export type { HerdrAgent, KeepGoingDependencies } from './keep-going-context.ts';
export { formatMytTimestamp } from './keep-going-nudge.ts';

/**
 * Root of the throne project (three levels up from this file), resolved from
 * the module location — NEVER cwd, since the
 * systemd timer fires from anywhere. Mirrors throne-startup.ts.
 */
const THRONE_ROOT = RUNTIME_THRONE_ROOT;
const NAME_FLAG = '--name';

function parseNameFlag(args: string[]): string | undefined {
  const idx = args.indexOf(NAME_FLAG);
  if (idx === -1) {
    return undefined;
  }
  return args[idx + 1];
}

let productionDependencies: KeepGoingDependencies | undefined;

const REAL_KEEP_GOING_DEPENDENCIES: KeepGoingDependencies = {
  resolveAgent,
  findLiveRegent,
  readDesiredState,
  // Resurrection and nudges both route through the durable queue — no
  // code-level bypass (Lord's ruling, 2026-08-11): keep-going, no-idling,
  // and the throne-work drain server are all throne code, so a "resurrect
  // directly if the server looks dead" branch would be throne code
  // defending against throne code being broken. The real safety net for a
  // dead/crash-looping drain server is systemd's `Restart=always` on
  // `throne-work.service`, one layer below the throne. See
  // `regent-resurrection.ts`.
  resurrectRegent: enqueueRegentResurrection,
  submitToAgent: submitToAgentViaQueue,
  evaluateThrottle: (harness) => new ThrottleSteeringService().evaluate(harness),
  now: () => new Date(),
  getRoster: async () => getAgentStatusesRoster(),
  readStallEvidence,
  resolveHeartbeatRoot: async () => THRONE_ROOT,
  evaluateRegentFence: evaluateRegentFenceReal,
  runRegentFenceOrchestration,
};

export function configureKeepGoingDependencies(
  dependencies: KeepGoingDependencies,
): void {
  productionDependencies = dependencies;
}

/**
 * The dependency bag any in-process caller (the hosted cron worker, the REST
 * route handler) should resolve against: whatever `configureKeepGoingDependencies`
 * installed, else the real bag, with `overrides` (typically just capturing
 * `stdout`/`stderr`) layered on top. Never used by `run()`'s own default
 * parameter, which resolves the same way independently -- this is for callers
 * that need to ALSO inject output sinks without losing whatever production
 * override is active.
 */
export function resolveKeepGoingDependencies(
  overrides: Partial<KeepGoingDependencies> = {},
): KeepGoingDependencies {
  return { ...(productionDependencies ?? REAL_KEEP_GOING_DEPENDENCIES), ...overrides };
}

/** Send the standing nudge to a resolved target through the common submit engine. */
async function nudge(
  target: HerdrAgent,
  deps: KeepGoingDependencies,
  throttleBand: ThrottleBand = UNTHROTTLED_EVALUATION.band,
  recoveryFamilies: readonly FamilyRecoverySummary[] = [],
): Promise<void> {
  const message =
    target.name !== undefined && sameAgentName(target.name, REGENT_NAME)
      ? buildRegentNudgeText(deps.now, throttleBand, recoveryFamilies)
      : GENERAL_NUDGE_TEXT;
  const options: SubmitToAgentOptions = {
    key: keepGoingWindowKey(target, deps.now()),
  };
  await deps.submitToAgent(target, 'keep-going', message, options);
}

/**
 * Explicit `--name <agent>` path: nudge exactly that named agent, nothing else.
 * No desired-state, no resurrection — an operator asked for a specific target.
 */
async function nudgeNamed(name: string, deps: KeepGoingDependencies): Promise<number> {
  let target: HerdrAgent;
  try {
    target = await deps.resolveAgent(name);
  } catch (err) {
    writeErr(deps, `${errText(err)}\n`);
    return 1;
  }
  await nudge(target, deps);
  writeOut(deps, `keep-going: nudged ${target.name ?? target.paneId}.\n`);
  return 0;
}

export async function run(
  args: string[],
  deps: KeepGoingDependencies = productionDependencies ?? REAL_KEEP_GOING_DEPENDENCIES,
): Promise<number> {
  writeOut(deps, formatCapacityPressureReportLine(readCapacityPressure()));
  writeOut(deps, formatQueueBacklogReportLine(countUnlaunchedQueueItems()));
  const pendingEligibilityDepthReport = renderKeepGoingEligibilityDepthReport();
  const name = parseNameFlag(args);
  const exitCode =
    name !== undefined ? await nudgeNamed(name, deps) : await tendRegent(deps, nudge);
  writeOut(deps, await pendingEligibilityDepthReport);
  return exitCode;
}
