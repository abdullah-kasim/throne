import { run as runDismissRegent } from "../dismiss-regent/dismiss-regent-runtime.ts";
import { run as runSummonRegent } from "../summon-regent/summon-regent-runtime.ts";
import { REGENT_NAME } from "../regent-state/regent-state.service.ts";
import { NotificationService } from "../notify-lord/notification.service.ts";
import { readSuiteArbitrationState, type HeldCampaign } from "./suite-arbitration-ledger.ts";
import { writeFenceHandoffRecord, type FenceHandoffRecord } from "./fence-handoff-record.ts";
import { appendFenceLedgerEntry, type FenceLedgerEntry } from "./fence-ledger.ts";
import type { RegentFenceReason } from "./decide-regent-fence-action.ts";
import {
  DEFAULT_FENCE_HANDOFF_RECORD_PATH,
  DEFAULT_FENCE_LEDGER_PATH,
  DEFAULT_SUITE_ARBITRATION_LEDGER_PATH,
} from "./regent-fencing-paths.ts";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Injectable seam for `runRegentFenceOrchestration`, mirroring the
 * `DismissDeps`/`SummonDeps` seam of the commands it composes.
 */
export interface RunRegentFenceOrchestrationDeps {
  readSnapshot: () => Promise<HeldCampaign[]>;
  writeHandoffRecord: (record: FenceHandoffRecord) => Promise<void>;
  runDismissRegent: () => Promise<number>;
  runSummonRegent: () => Promise<number>;
  appendFenceLedgerEntry: (entry: FenceLedgerEntry) => Promise<void>;
  /** Best-effort: never rejects. Failures are logged by the implementation,
   *  exactly as `notify-lord`'s own established failure-logging does. */
  notifyLord: (message: string) => Promise<void>;
}

async function notifyLordBestEffort(message: string): Promise<void> {
  try {
    await new NotificationService().send(message);
  } catch (err) {
    process.stderr.write(
      `run-regent-fence-orchestration: failed to notify the Lord (${errText(err)})\n`,
    );
  }
}

export const REAL_DEPS: RunRegentFenceOrchestrationDeps = {
  readSnapshot: async () => {
    const state = await readSuiteArbitrationState(DEFAULT_SUITE_ARBITRATION_LEDGER_PATH);
    // An unreadable arbitration ledger degrades to an empty snapshot rather
    // than blocking the fence -- mirrors notify-lord's own queue-unavailable
    // degrade-not-block precedent (`notification.service.ts`'s `renderQueue`
    // failure handling).
    return state.state === "ok" ? state.heldCampaigns : [];
  },
  writeHandoffRecord: (record) => writeFenceHandoffRecord(DEFAULT_FENCE_HANDOFF_RECORD_PATH, record),
  runDismissRegent: () => runDismissRegent([]),
  runSummonRegent: () => runSummonRegent([]),
  appendFenceLedgerEntry: (entry) => appendFenceLedgerEntry(DEFAULT_FENCE_LEDGER_PATH, entry),
  notifyLord: notifyLordBestEffort,
};

function fenceMessage(reason: RegentFenceReason, outcome: string): string {
  return (
    `Regent fenced: ${reason.openCount} open queue item(s), ` +
    `${reason.minutesIdle.toFixed(1)} minutes idle. ${outcome}`
  );
}

/**
 * Composes the six-step fence sequence documented on the `fence` verdict
 * from `decideRegentFenceAction`: snapshot arbitration state, write the
 * handoff record, dismiss the wedged Regent, summon its replacement,
 * ledger the outcome, and notify the Lord. Steps 1-2 read/write BEFORE
 * dismissal so the snapshot reflects the wedged Regent's own state.
 *
 * A dismiss failure stops before summon is attempted (a failed dismiss may
 * still leave the old Regent live, so summon would be a same-Regent no-op)
 * and is recorded, not thrown. A summon failure after a successful dismiss
 * is also recorded, not retried here -- keep-going's existing
 * `regent === null` resurrection branch already recovers a dead Regent on
 * its next tick.
 */
export async function runRegentFenceOrchestration(
  reason: RegentFenceReason,
  deps: RunRegentFenceOrchestrationDeps = REAL_DEPS,
): Promise<void> {
  const firedAt = new Date(reason.now).toISOString();
  const suiteArbitrationSnapshot = await deps.readSnapshot();
  await deps.writeHandoffRecord({
    firedAt,
    openItemCount: reason.openCount,
    minutesIdle: reason.minutesIdle,
    suiteArbitrationSnapshot,
  });

  const dismissExit = await deps.runDismissRegent();
  if (dismissExit !== 0) {
    await deps.appendFenceLedgerEntry({
      firedAt,
      openItemCount: reason.openCount,
      minutesIdle: reason.minutesIdle,
      dismissedRegentName: REGENT_NAME,
      summonedRegentName: REGENT_NAME,
      dismissFailed: true,
    });
    await deps.notifyLord(fenceMessage(reason, "Dismiss failed; summon was not attempted."));
    return;
  }

  const summonExit = await deps.runSummonRegent();
  await deps.appendFenceLedgerEntry({
    firedAt,
    openItemCount: reason.openCount,
    minutesIdle: reason.minutesIdle,
    dismissedRegentName: REGENT_NAME,
    summonedRegentName: REGENT_NAME,
    ...(summonExit !== 0 ? { summonFailed: true } : {}),
  });
  await deps.notifyLord(
    fenceMessage(
      reason,
      summonExit === 0
        ? "Dismissed and summoned a fresh Regent."
        : "Dismissed, but summon failed; the resurrection watchdog will recover it.",
    ),
  );
}
