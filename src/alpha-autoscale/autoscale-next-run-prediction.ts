import type { PressureClassification } from "../pressure-signal/classify-pressure.ts";
import type { LaunchLedgerResult } from "../alpha-launch-queue/launch-ledger-reader.ts";
import type { FloorAwareAutoscaleAction } from "./decide-autoscale-action.ts";
import type { AlphaAutoscaleCooldownStatus } from "./alpha-autoscale-schedule-dedupe.ts";
import {
  autoBriefUnknownReason,
  launchLedgerUnknownReason,
  launchStopReason,
  skipReasonForDecision,
  unresolvedLaunchHistoryMessage,
} from "./autoscale-skip-wording.ts";

export type AutoscaleConfigPause =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: string };

export interface NextRunInputs {
  readonly configPause: AutoscaleConfigPause;
  readonly unreadableQueueReason: string | null;
  readonly selectedCandidateLedger: LaunchLedgerResult | undefined;
  readonly decision: FloorAwareAutoscaleAction;
  readonly cooldown: AlphaAutoscaleCooldownStatus;
  readonly pressure: PressureClassification;
  readonly launchBudget: number;
}

const NOTHING_LAUNCHED_YET: ReadonlySet<string> = new Set();

function wouldSkip(reason: string): string {
  return `would skip: ${reason}`;
}

export function predictNextRun(inputs: NextRunInputs): string {
  if (!inputs.configPause.enabled) return wouldSkip(inputs.configPause.reason);
  if (inputs.unreadableQueueReason !== null) {
    return wouldSkip(autoBriefUnknownReason(inputs.unreadableQueueReason));
  }
  if (inputs.selectedCandidateLedger?.state === "unknown") {
    return wouldSkip(launchLedgerUnknownReason(inputs.selectedCandidateLedger.reason));
  }
  const decision = inputs.decision;
  if (decision.action === "skip") {
    return wouldSkip(skipReasonForDecision(decision, inputs.cooldown));
  }
  if (decision.action === "unresolved") {
    return wouldSkip(unresolvedLaunchHistoryMessage(decision.name));
  }
  const stopReason = launchStopReason(
    NOTHING_LAUNCHED_YET,
    inputs.launchBudget,
    inputs.pressure,
    decision.candidate.name,
  );
  if (stopReason !== undefined) return wouldSkip(stopReason);
  return `would spawn ${decision.candidate.objectiveCode} as ${decision.candidate.name}`;
}
