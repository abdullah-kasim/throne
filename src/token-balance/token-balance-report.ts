// Pure verdict scoring for the token-lane load balancer. Given each lane's
// already-parsed 5h and weekly usage windows (the shape `usagerate.ts`'s
// `computeUsageRates` already produces — jitter-safe burn rate plus current
// remaining-percent), picks which lane new balanced-role spawns should land
// on, or reports that both lanes are unusable. No filesystem, env, process,
// or Nest-DI access: every input arrives as a plain data parameter so the
// module is fixture-testable without mocking. Callers own reading
// `config.user.ts`/`usage-log.jsonl` and checking the kill switch and the
// operator disable setting before calling in.

/** One usage window's burn-rate inputs, shaped like `usagerate.ts`'s
 *  `RateResult.today` / `RateResult.seven_day`: current remaining-percent,
 *  the jitter-safe burn rate (null when there is not enough history to
 *  compute one), and how many hours remain until this window resets. */
export interface LaneUsageWindow {
  readonly remainingPct: number;
  readonly pctPerHour: number | null;
  readonly hoursUntilReset: number;
}

/** A lane's parsed 5h and weekly usage, ready for scoring. `laneId` is the
 *  lane's name as recorded in `config.user.ts`'s `steering.customPlanPresets`
 *  (e.g. `SonnetLow`, `TerraLow`) — the module treats it as opaque data, not
 *  an enum, so a third lane needs no code change here. */
export interface LaneUsageSnapshot {
  readonly laneId: string;
  readonly fiveHour: LaneUsageWindow;
  readonly weekly: LaneUsageWindow;
}

/** Per-lane scoring detail surfaced in the verdict for diagnostics (the CLI
 *  report and any future debugging), never recomputed by a consumer. */
export interface LaneScore {
  readonly laneId: string;
  readonly disqualified: boolean;
  readonly projectedFiveHourRemainingPct: number;
  readonly projectedWeeklyRemainingPct: number;
  readonly score: number;
}

export type LaneBalanceVerdict =
  | { readonly blocked: false; readonly chosenLane: string; readonly perLaneScores: readonly LaneScore[] }
  | { readonly blocked: true; readonly reason: string; readonly perLaneScores: readonly LaneScore[] };

/**
 * A lane's 5h window counts as exhausted-or-near-exhausted, and the lane is
 * disqualified outright, once its current remaining-percent drops to this
 * floor or below. 5% is chosen because the plan-usage sensors report whole
 * percentage points, so single digits are the smallest signal that survives
 * rounding, and because at that level one more agent spawn's marginal burn
 * can exhaust the window before the next balancer check runs — there is no
 * safety margin left to spend.
 */
export const FIVE_HOUR_NEAR_EXHAUSTION_FLOOR_PCT = 5;

/** Remaining-percent projected at the window's reset, given its current
 *  remaining-percent and burn rate. A `null` burn rate means there is not
 *  enough history to extrapolate, so the current remaining-percent is the
 *  only known value and stands in as the projection unchanged. */
function projectRemainingAtReset(window: LaneUsageWindow): number {
  if (window.pctPerHour === null) return window.remainingPct;
  return window.remainingPct - window.pctPerHour * window.hoursUntilReset;
}

/**
 * A lane's 5h window disqualifies it outright when either: the window is
 * already at or below the near-exhaustion floor, or its burn rate projects
 * it past zero before the window resets. Either condition alone is
 * sufficient — this is the one place either check runs; no per-lane inline
 * copy exists elsewhere.
 */
export function isLaneDisqualified(window: LaneUsageWindow): boolean {
  if (window.remainingPct <= FIVE_HOUR_NEAR_EXHAUSTION_FLOOR_PCT) return true;
  return projectRemainingAtReset(window) <= 0;
}

function scoreLane(lane: LaneUsageSnapshot): LaneScore {
  const projectedFiveHourRemainingPct = projectRemainingAtReset(lane.fiveHour);
  const projectedWeeklyRemainingPct = projectRemainingAtReset(lane.weekly);
  return {
    laneId: lane.laneId,
    disqualified: isLaneDisqualified(lane.fiveHour),
    projectedFiveHourRemainingPct,
    projectedWeeklyRemainingPct,
    score: Math.min(projectedFiveHourRemainingPct, projectedWeeklyRemainingPct),
  };
}

/**
 * Scores every lane and picks the one new balanced-role spawns should use.
 * A lane whose 5h window is exhausted or near-exhausted is disqualified
 * outright, regardless of its proportional score. With exactly one lane
 * disqualified, the other is chosen unconditionally — every new spawn, no
 * rate brake. With both lanes disqualified, the verdict blocks with a
 * stated reason rather than picking a poisoned lane. Otherwise the
 * higher-scoring (worse-of-5h/weekly, less depleted) lane wins; a tie
 * resolves to whichever lane appears first in `lanes`, a stated
 * deterministic default.
 */
export function scoreLanes(lanes: readonly LaneUsageSnapshot[]): LaneBalanceVerdict {
  const perLaneScores = lanes.map(scoreLane);
  const eligible = perLaneScores.filter((lane) => !lane.disqualified);

  if (eligible.length === 0) {
    const reason =
      perLaneScores.length === 0
        ? 'no lanes were supplied to score'
        : `both lanes disqualified: ${perLaneScores.map((lane) => lane.laneId).join(', ')} all have an exhausted or near-exhausted 5h window`;
    return { blocked: true, reason, perLaneScores };
  }

  const chosen = eligible.reduce((best, candidate) =>
    candidate.score > best.score ? candidate : best,
  );
  return { blocked: false, chosenLane: chosen.laneId, perLaneScores };
}
