import { countLiveAlphas } from "../keep-going/alpha-capacity.ts";
import {
  decideAutoscaleActionWithFloor,
  type DecideAutoscaleActionInput,
  type FloorAwareAutoscaleAction,
} from "./decide-autoscale-action.ts";
import {
  alphaFloorBreachTracker,
  type AlphaFloorBreachTracker,
} from "./alpha-floor-breach-tracker.ts";
import { ALPHA_AUTOSCALE_BOUNDS } from "./alpha-autoscale-bounds.ts";

/** Hard minimum of concurrent live Alphas -- below this, the floor-aware
 *  decision may force a spawn past known-pressure/at-capacity holds, but
 *  never past the global spawn interval. */
export const ALPHA_LIVE_FLOOR_MINIMUM = ALPHA_AUTOSCALE_BOUNDS.floor;

/**
 * What actually happened to a `spawn` decision after the worker tried to
 * act on it.
 *
 * WHY THIS EXISTS: the decision alone is an INTENTION. A tick can decide to
 * spawn and then fail to, at any of seven points after the decision -- a
 * second dispatch-pressure refusal, an unresolvable published `dist`, a
 * `spawn-git-tree` failure, an empty worktree path, a `create-agent`
 * failure, a retryable-exhausted `create-agent`, or a spawn-limiter write
 * that throws. The breach notice used to be rendered from the decision and
 * sent BEFORE any of that ran, so every one of those failures produced a
 * page reading `This tick spawned "X"` when nothing had been spawned. The
 * Regent hit this on objective `acp`: the page named an Alpha that had no
 * ledger, no worktree, no archived ledger under `.reaped`, and a queue row
 * still `open`. Reporting a filled floor to the one reader whose job is
 * noticing an unfilled floor is the exact failure the floor mechanism was
 * built to prevent.
 */
export type AlphaFloorSpawnOutcome =
  | { readonly kind: "spawned" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly stage: string; readonly detail: string };

/** Everything the breach notifier needs to build a breach message without
 *  re-deriving this tick's decision: the live count and floor that decided
 *  breach state, how long the breach has persisted, what this tick's
 *  autoscale decision did about it, and -- for a `spawn` decision -- whether
 *  acting on it actually succeeded. `spawnOutcome` is absent only when the
 *  decision was not `spawn`; a `spawn` decision with no outcome is a caller
 *  bug and the notice says so rather than guessing. */
export interface AlphaFloorBreachSnapshot {
  readonly liveAlphaCount: number;
  readonly floorMinimum: number;
  readonly breachDurationMs: number;
  readonly decision: FloorAwareAutoscaleAction;
  readonly spawnOutcome?: AlphaFloorSpawnOutcome;
}

/**
 * Computes live-Alpha count, tracks per-tick breach duration on `tracker`,
 * and calls `decideAutoscaleActionWithFloor` -- the one place the hosted
 * worker gets its floor-aware decision, kept pure (aside from the tracker's
 * own in-memory mutation) and independently testable without mocking the
 * worker's PSI/roster/ledger reads.
 */
export function resolveFloorAwareAutoscaleTick(
  baseInput: DecideAutoscaleActionInput,
  tracker: AlphaFloorBreachTracker = alphaFloorBreachTracker,
): AlphaFloorBreachSnapshot {
  const liveAlphaCount = countLiveAlphas(baseInput.activeRecords);
  const breached = liveAlphaCount < ALPHA_LIVE_FLOOR_MINIMUM;
  const breachDurationMs = tracker.recordTick(breached);
  const decision = decideAutoscaleActionWithFloor({
    ...baseInput,
    liveAlphaCount,
    floorMinimum: ALPHA_LIVE_FLOOR_MINIMUM,
    hardMaximum: ALPHA_AUTOSCALE_BOUNDS.hardMaximum,
  });
  return {
    liveAlphaCount,
    floorMinimum: ALPHA_LIVE_FLOOR_MINIMUM,
    breachDurationMs,
    decision,
  };
}
