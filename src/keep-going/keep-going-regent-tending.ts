// Regent tending: stalled-Alpha recovery detection, wedged-Regent fence
// evaluation, and the top-level decision tree that composes both around the
// heartbeat nudge. Reason to change: how the keep-going tick decides what to
// do about the Regent's health, not what the nudge says or how it is sent.

import {
  aggregateFamilyRecovery,
  type FamilyRecoverySummary,
} from './keep-going-stalls.ts';
import type {
  DesiredState,
  HerdrAgent,
  KeepGoingDependencies,
  ThrottleBand,
} from './keep-going-context.ts';
import {
  DESIRED_STATES,
  errText,
  KEEP_GOING_TICK_MINUTES,
  KEEP_GOING_TICK_MS,
  writeErr,
  writeOut,
} from './keep-going-context.ts';
import { evaluateLiveRegentThrottle } from './keep-going-nudge.ts';
import { RUNTIME_DATA_DIR } from '../shared-policy/runtime-data-home.ts';
import { isRegentFencingKillSwitchOn } from '../regent-fencing/regent-fencing-kill-switch.ts';
import {
  decideRegentFenceAction,
  REGENT_FENCE_GRACE_PERIOD_MS,
  type RegentFenceAction,
} from '../regent-fencing/decide-regent-fence-action.ts';
import { runRegentFenceOrchestration } from '../regent-fencing/run-regent-fence-orchestration.ts';
import { openRegentQueueStore } from '../regent-queue/regent-queue.store.ts';
import { readLaunchLedger } from '../alpha-launch-queue/launch-ledger-reader.ts';
import { DEFAULT_LAUNCH_LEDGER_PATH } from '../alpha-launch-queue/paths.ts';
import { readFenceLedger, findMostRecentFenceAtMs } from '../regent-fencing/fence-ledger-reader.ts';
import { DEFAULT_FENCE_LEDGER_PATH } from '../regent-fencing/regent-fencing-paths.ts';

/** Sends the standing nudge to a resolved target; owned by the caller so this
 *  module never needs its own `submitToAgent` call site. */
export type SendKeepGoingNudge = (
  target: HerdrAgent,
  deps: KeepGoingDependencies,
  throttleBand?: ThrottleBand,
  recoveryFamilies?: readonly FamilyRecoverySummary[],
) => Promise<void>;

/**
 * Reads the queue and launch-ledger state `decideRegentFenceAction` needs
 * and decides. Checks the kill switch FIRST and returns its no-op before
 * touching the queue database, launch ledger, or fence ledger -- so with
 * fencing dark (the default), this is a pure env-var read on every tick.
 */
export async function evaluateRegentFenceReal(): Promise<RegentFenceAction> {
  const killSwitchOn = isRegentFencingKillSwitchOn();
  if (!killSwitchOn) {
    return { action: 'no-op', reason: 'kill switch off' };
  }

  const store = openRegentQueueStore();
  let queueState;
  try {
    queueState = store.readAll();
  } finally {
    store.close();
  }
  const launchLedgerState = await readLaunchLedger(DEFAULT_LAUNCH_LEDGER_PATH);
  const fenceLedgerResult = await readFenceLedger(DEFAULT_FENCE_LEDGER_PATH);
  const lastFenceAt =
    fenceLedgerResult.state === 'ok'
      ? findMostRecentFenceAtMs(fenceLedgerResult.entries)
      : undefined;

  return decideRegentFenceAction({
    killSwitchOn,
    queueState,
    launchLedgerState,
    now: Date.now(),
    lastFenceAt,
    gracePeriodMs: REGENT_FENCE_GRACE_PERIOD_MS,
  });
}

async function detectStalledAlphaRecovery(
  deps: KeepGoingDependencies,
): Promise<readonly FamilyRecoverySummary[]> {
  const root = await deps.resolveHeartbeatRoot!();
  const roster = await deps.getRoster!(root);
  const evidence = await deps.readStallEvidence!(
    roster,
    deps.now().getTime(),
    RUNTIME_DATA_DIR,
  );
  const families = aggregateFamilyRecovery(evidence);
  for (const family of families) {
    writeOut(deps, `keep-going: reported stalled family ${family.alpha} to Regent.\n`);
  }
  if (families.length === 0) {
    writeOut(deps, 'keep-going: no stalled families detected.\n');
  }
  return families;
}

/**
 * Default path: the Regent heartbeat + self-heal, gated on declarative intent.
 * Reads desired-state first (failing SAFE toward `running`), then nudges a live
 * Regent or resurrects a dead one. Idempotent — resurrection only fires when
 * `findLiveRegent` returns null, so a second Regent is never spawned.
 */
export async function tendRegent(
  deps: KeepGoingDependencies,
  sendNudge: SendKeepGoingNudge,
): Promise<number> {
  let desired: DesiredState;
  try {
    desired = await deps.readDesiredState();
  } catch (err) {
    // Reading intent must never silently dismiss the court: an unreadable
    // marker is treated as `running` (regentstate does this too; guard here
    // as well so a surprise error fails toward keeping the Regent alive).
    writeErr(
      deps,
      `keep-going: could not read desired-state (${errText(err)}); assuming "running"\n`,
    );
    desired = DESIRED_STATES.RUNNING;
  }

  if (desired === DESIRED_STATES.DISMISSED) {
    writeOut(
      deps,
      'keep-going: Regent desired-state is "dismissed" — no nudge, no resurrect.\n',
    );
    return 0;
  }

  let regent: HerdrAgent | null;
  try {
    regent = await deps.findLiveRegent();
  } catch (err) {
    // A real herdr failure (not "absent") — do NOT resurrect on top of a
    // possibly-live Regent we simply failed to see.
    writeErr(deps, `${errText(err)}\n`);
    return 1;
  }

  if (regent !== null) {
    const fenceAction = await (deps.evaluateRegentFence ?? evaluateRegentFenceReal)();
    if (fenceAction.action === 'fence') {
      await (deps.runRegentFenceOrchestration ?? runRegentFenceOrchestration)(
        fenceAction.reason,
      );
      writeOut(
        deps,
        `keep-going: fenced wedged Regent (${fenceAction.reason.openCount} open queue item(s), ` +
          `${fenceAction.reason.minutesIdle.toFixed(1)} minutes idle) — dismissed, summoned, ` +
          'skipping this tick\'s ordinary nudge.\n',
      );
      return 0;
    }

    let recoveryFamilies: readonly FamilyRecoverySummary[] = [];
    try {
      recoveryFamilies = await detectStalledAlphaRecovery(deps);
    } catch (err) {
      writeErr(
        deps,
        `keep-going: stalled Alpha detection failed (${errText(err)}); continuing Regent heartbeat\n`,
      );
    }
    const throttle = await evaluateLiveRegentThrottle(regent.agent, deps);
    if (!throttle.shouldNudge) {
      const effectiveIntervalMinutes =
        Math.ceil(throttle.band.minIntervalMs / KEEP_GOING_TICK_MS) *
        KEEP_GOING_TICK_MINUTES;
      writeOut(
        deps,
        `keep-going: throttle band ${throttle.band.name} — skipping this tick's Regent nudge (min interval ~${effectiveIntervalMinutes}m).\n`,
      );
      return 0;
    }
    await sendNudge(regent, deps, throttle.band, recoveryFamilies);
    writeOut(deps, `keep-going: nudged Regent (throttle band ${throttle.band.name}).\n`);
    return 0;
  }

  try {
    await deps.resurrectRegent();
    writeOut(
      deps,
      'keep-going: no live Regent + desired "running" — resurrected a fresh Regent.\n',
    );
    return 0;
  } catch (err) {
    writeErr(
      deps,
      `keep-going: Regent resurrection failed (${errText(err)})\n`,
    );
    return 1;
  }
}
