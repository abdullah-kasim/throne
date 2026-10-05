import { AUTOSCALE_KILL_SWITCH_ENV_VAR } from "./kill-switch.ts";
import type { AutoscaleStatusReport } from "./autoscale-status-report.ts";
import type { AutoscaleStatusQueue } from "./autoscale-status-queue.ts";

export const LOCAL_READING_BANNER =
  "backend unreachable — kill switch and breach duration are this shell's view and may differ from the backend's";
export const UNKNOWN_NEXT_RUN = "every 5 minutes, next time unknown";
export const PREDICTION_CAVEAT =
  "a prediction: pressure and the queue can change before the tick";

export type AutoscaleStatusFormat = "text" | "json";

function describeDuration(milliseconds: number): string {
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return minutes === 0 ? `${totalSeconds}s` : `${minutes}m ${totalSeconds % 60}s`;
}

function describeAutoscaler(report: AutoscaleStatusReport): string[] {
  const { autoscaler } = report;
  const pauses = [
    ...(autoscaler.configPauseReason === null
      ? []
      : [`paused by steering.autoscaleEnabled: ${autoscaler.configPauseReason}`]),
    ...(autoscaler.killSwitchOn
      ? []
      : [`paused by the kill switch ${AUTOSCALE_KILL_SWITCH_ENV_VAR}=0`]),
  ];
  return [
    `1. Autoscaler: ${autoscaler.running ? "running" : "paused"}`,
    ...pauses.map((pause) => `   ${pause}`),
    autoscaler.sweepHoldingLockSince === null
      ? "   no sweep is running now"
      : `   a sweep is running now (${autoscaler.sweepHoldingLockSince})`,
  ];
}

function describeNextRun(report: AutoscaleStatusReport): string[] {
  return [
    report.nextRun === null
      ? `2. Next scheduled run: ${UNKNOWN_NEXT_RUN}`
      : `2. Next scheduled run: in ${describeDuration(report.nextRun.inMs)} (${report.nextRun.at})`,
  ];
}

function describeSlots(report: AutoscaleStatusReport): string[] {
  const { slots } = report;
  return [
    `3. Slots: ${slots.free} free (capacity ${slots.capacity}, live Alphas ${slots.live})`,
    `   floor ${slots.floor}: ${slots.floorBreached ? `breached for ${describeDuration(slots.breachDurationMs)}` : "met"}`,
    ...slots.liveAlphas.map(
      (alpha) => `   - ${alpha.name}: ${alpha.objectiveCode ?? "no queue row"}`,
    ),
  ];
}

function describePressure(report: AutoscaleStatusReport): string[] {
  const { pressure } = report;
  return [
    `4. Machine pressure: ${pressure.verdict} at ${pressure.value ?? "unknown"}; launch budget ${pressure.launchBudget}; ${pressure.holdingSpawns ? "holding spawns" : "not holding spawns"}`,
    ...pressure.reasons.map((reason) => `   ${reason}`),
  ];
}

function describeCooldown(report: AutoscaleStatusReport): string[] {
  return [
    report.cooldown.elapsed
      ? "5. Spawn cooldown: elapsed"
      : `5. Spawn cooldown: not elapsed: ${report.cooldown.reason}`,
  ];
}

function describeQueue(queue: AutoscaleStatusQueue): string[] {
  const listOrNone = (lines: string[]): string[] => (lines.length === 0 ? ["     none"] : lines);
  return [
    `6. Queue (ready queue ${queue.readyQueue}${queue.readyQueueReasons.length === 0 ? "" : `: ${queue.readyQueueReasons.join(", ")}`})`,
    "   launchable, in launch order:",
    ...listOrNone(
      queue.launchable.map(
        (row, index) =>
          `     ${index + 1}. ${row.objectiveCode} (priority ${row.priority ?? "unknown"}) as ${row.alphaName} -> ${row.targetRepo} ${row.targetBranch}; model hint ${row.modelHint ?? "none"}${row.sliceless ? "; sliceless" : ""}${row.shadowless ? "; shadowless" : ""}`,
      ),
    ),
    "   open but not launchable:",
    ...listOrNone(queue.notLaunchable.map((row) => `     ${row.objectiveCode}: ${row.reason}`)),
    "   deferred:",
    ...listOrNone(
      queue.deferred.map(
        (row) =>
          `     ${row.objectiveCode} (priority ${row.priority}) waits on ${row.releaseAuthority === null ? (row.waitsOn.join(", ") || "nothing named") : `${row.releaseAuthority}'s ruling`}${row.reason === null ? "" : ` (${row.reason})`}; ${row.wouldRelease ? "would release on the next run" : "stays held on the next run"}`,
      ),
    ),
    "   in flight:",
    ...listOrNone(queue.inFlight.map((row) => `     ${row.objectiveCode}: ${row.alphaName ?? "no agent"}`)),
    `   would brief on the next run: ${queue.wouldBrief.join(", ") || "none"}`,
    `   would recover on the next run: ${queue.wouldRecover ?? "none"}`,
    `   repositories being changed now: ${queue.mutatingTargets.join(", ") || "none"}`,
  ];
}

function describePrediction(report: AutoscaleStatusReport): string[] {
  return [`7. Next run (${PREDICTION_CAVEAT}): ${report.prediction}`];
}

export function renderAutoscaleStatus(
  report: AutoscaleStatusReport,
  format: AutoscaleStatusFormat,
): string {
  const banner = report.viewpoint === "this shell" ? LOCAL_READING_BANNER : null;
  if (format === "json") {
    return `${JSON.stringify({ warning: banner, ...report, predictionCaveat: PREDICTION_CAVEAT }, null, 2)}\n`;
  }
  return `${[
    ...(banner === null ? [] : [banner]),
    ...describeAutoscaler(report),
    ...describeNextRun(report),
    ...describeSlots(report),
    ...describePressure(report),
    ...describeCooldown(report),
    ...describeQueue(report.queue),
    ...describePrediction(report),
  ].join("\n")}\n`;
}
