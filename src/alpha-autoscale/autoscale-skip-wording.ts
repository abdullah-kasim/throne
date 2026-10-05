import type { PressureClassification } from "../pressure-signal/classify-pressure.ts";
import type { FloorAwareAutoscaleAction } from "./decide-autoscale-action.ts";
import type { AlphaAutoscaleCooldownStatus } from "./alpha-autoscale-schedule-dedupe.ts";

const GENERIC_COOLDOWN_REASON = "cooldown not yet elapsed since last spawn";

export function autoBriefUnknownReason(reason: string): string {
  return `auto-brief unknown: ${reason}`;
}

export function launchLedgerUnknownReason(reason: string): string {
  return `launch ledger unknown: ${reason}`;
}

export function skipReasonForDecision(
  decision: Extract<FloorAwareAutoscaleAction, { action: "skip" }>,
  cooldown: AlphaAutoscaleCooldownStatus,
): string {
  return decision.reason === GENERIC_COOLDOWN_REASON && !cooldown.elapsed
    ? cooldown.reason
    : decision.reason;
}

export function unresolvedLaunchHistoryMessage(name: string): string {
  return `launch history unresolved for "${name}" -- refusing to spawn (distinct from an empty queue)`;
}

export function launchStopReason(
  launchedThisTick: ReadonlySet<string>,
  launchBudget: number,
  pressure: PressureClassification,
  candidateName: string,
): string | undefined {
  if (launchedThisTick.size >= launchBudget) {
    return `launch budget of ${launchBudget} for tick pressure ${pressure.pressure ?? "unknown"} is spent`;
  }
  if (launchedThisTick.has(candidateName)) {
    return `"${candidateName}" was already launched this tick and is still offered by the ready queue`;
  }
  return undefined;
}
