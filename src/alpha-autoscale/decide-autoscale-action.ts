import type { PressureClassification } from "../pressure-signal/classify-pressure.ts";
import type {
  ReadyQueueResult,
  LaunchQueueCandidate,
} from "../alpha-launch-queue/ready-queue.ts";
import type { LaunchRecord } from "../alpha-launch-queue/launch-ledger-reader.ts";
import {
  admitQueuedAlpha,
  type AlphaReadinessRecord,
} from "../keep-going/alpha-capacity.ts";

export type AutoscaleAction =
  | { readonly action: "spawn"; readonly candidate: LaunchQueueCandidate }
  | {
      readonly action: "skip";
      readonly reason: string;
      /** True ONLY when the refusal was "there is nothing launchable at all",
       *  as distinct from "there is launchable work and something is holding
       *  it back" (cooldown, kill switch, capacity, an unresolved ledger).
       *
       *  It exists so the floor-breach page can tell an EMPTY court from a
       *  STARVING one. A structured flag rather than matching on `reason`
       *  prose: the reason strings are human text that gets reworded, and a
       *  page that goes silent because someone improved a sentence is a
       *  worse defect than the noise it was suppressing. */
      readonly noLaunchableWork: boolean;
    }
  | { readonly action: "unresolved"; readonly name: string };

export interface DecideAutoscaleActionInput {
  readonly pressure: PressureClassification;
  readonly readyQueue: ReadyQueueResult;
  /** The resolved ledger entry for the ready-queue's own first candidate's
   *  objective code, or `undefined` when the ledger has no launch record for
   *  it at all (never launched before -- not a duplicate). */
  readonly selectedCandidateLedgerEntry: LaunchRecord | undefined;
  readonly cooldownElapsed: boolean;
  readonly killSwitchOn: boolean;
  readonly activeRecords: readonly AlphaReadinessRecord[];
  readonly mutatingTargets: readonly string[];
  readonly capacity: number;
}

/**
 * The one place the spawn decision is made. Every refusal signal below is
 * independent and fails closed on its own -- none can be overridden by any
 * other signal being favorable, and the checks below can run in any order
 * because each one alone is sufficient to refuse:
 *
 * - pressure not positively `take-more-work` (covers both `at-capacity` and
 *   `unknown`)
 * - ready queue `unknown` (distinct refusal reason from positively-empty)
 * - ready queue `positively-empty` (never spams a retry -- this is a normal,
 *   named skip reason, not treated as an error)
 * - kill switch OFF
 * - cooldown not yet elapsed
 * - the selected candidate's ledger entry resolving to "launched and not
 *   terminated unsuccessfully" (`delivered`, or no status record at all --
 *   reported as `unresolved`, distinctly from every `skip` reason above);
 *   `abandoned`/`failed` do NOT block a relaunch
 * - `admitQueuedAlpha` (ceiling, target-overlap, dependency-gated) returning
 *   `admitted: false`
 */
export function decideAutoscaleAction(
  input: DecideAutoscaleActionInput,
): AutoscaleAction {
  if (input.pressure.verdict !== "take-more-work") {
    return {
      action: "skip",
      reason: `pressure verdict is "${input.pressure.verdict}"`,
      noLaunchableWork: false,
    };
  }
  if (input.readyQueue.state === "unknown") {
    return {
      action: "skip",
      reason: `ready queue unknown: ${input.readyQueue.reason}`,
      noLaunchableWork: false,
    };
  }
  if (input.readyQueue.state === "positively-empty") {
    return {
      action: "skip",
      reason: "ready queue positively empty",
      noLaunchableWork: true,
    };
  }
  if (input.readyQueue.state === "ineligible") {
    return {
      action: "skip",
      reason: `ready queue ineligible: ${input.readyQueue.reasons.join(", ")}`,
      noLaunchableWork: false,
    };
  }
  if (!input.killSwitchOn) {
    return { action: "skip", reason: "kill switch off", noLaunchableWork: false };
  }
  if (!input.cooldownElapsed) {
    return {
      action: "skip",
      reason: "cooldown not yet elapsed since last spawn",
      noLaunchableWork: false,
    };
  }

  const candidate = input.readyQueue.candidates[0]!;
  const ledgerEntry = input.selectedCandidateLedgerEntry;
  if (ledgerEntry !== undefined) {
    if (ledgerEntry.status === "unknown") {
      return { action: "unresolved", name: ledgerEntry.name };
    }
    if (ledgerEntry.status === "delivered") {
      return {
        action: "skip",
        reason: `duplicate: objective "${candidate.objectiveCode}" already delivered by "${ledgerEntry.name}"`,
        // Not "nothing to launch": a candidate IS present, and the queue
        // disagreeing with the ledger about it is an inconsistency somebody
        // should reconcile. Stays loud.
        noLaunchableWork: false,
      };
    }
    // 'abandoned' / 'failed' -- prior launch did not deliver, relaunch allowed.
  }

  const admission = admitQueuedAlpha(
    candidate,
    input.activeRecords,
    input.mutatingTargets,
    input.capacity,
  );
  if (!admission.admitted) {
    // Eligible work exists and something (ceiling, target overlap, a
    // dependency gate) is holding it back -- the starving case, which is
    // exactly what a floor page is for. Stays loud.
    return {
      action: "skip",
      reason: `admission refused: ${admission.reason}`,
      noLaunchableWork: false,
    };
  }

  return { action: "spawn", candidate };
}

export interface FloorAwareDecideAutoscaleActionInput extends DecideAutoscaleActionInput {
  readonly liveAlphaCount: number;
  readonly floorMinimum: number;
  readonly hardMaximum: number;
}

export type FloorAwareAutoscaleAction =
  | {
      readonly action: "spawn";
      readonly candidate: LaunchQueueCandidate;
      /** True when this spawn only happened because the live-Alpha count
       *  was below the floor and capacity was relaxed; false for an ordinary
       *  spawn that would have happened regardless. */
      readonly floorOverride: boolean;
    }
  | {
      readonly action: "skip";
      readonly reason: string;
      /** True when the live-Alpha count was below the floor at decision
       *  time, even though this particular refusal was not overridable. */
      readonly floorBreached: boolean;
      /** Carried through from `AutoscaleAction` -- see its own comment. */
      readonly noLaunchableWork: boolean;
    }
  | {
      readonly action: "unresolved";
      readonly name: string;
      readonly floorBreached: boolean;
    };

/**
 * Wraps `decideAutoscaleAction` so that a live-Alpha count below
 * `floorMinimum` forces a spawn past only `admitQueuedAlpha`'s capacity
 * refusal, after fresh pressure has positively permitted spawning. It never
 * forces past pressure `at-capacity`/`unknown`, ready-queue
 * unknown/positively-empty, kill switch, cooldown, ledger
 * unresolved/delivered, dependency-gated, or target-overlap refusals, which
 * stay correctness/safety facts regardless of the floor. Forcing re-runs the
 * unmodified seven-signal decision with only capacity relaxed, rather than
 * re-deriving its ordering here.
 * When `liveAlphaCount >= floorMinimum`, behavior is identical to calling
 * `decideAutoscaleAction` directly.
 */
export function decideAutoscaleActionWithFloor(
  input: FloorAwareDecideAutoscaleActionInput,
): FloorAwareAutoscaleAction {
  const { liveAlphaCount, floorMinimum, hardMaximum, ...baseInput } = input;
  const floorBreached = liveAlphaCount < floorMinimum;
  const ordinaryDecision = decideAutoscaleAction(baseInput);
  if (ordinaryDecision.action === "spawn" || !floorBreached) {
    return toFloorAwareAction(ordinaryDecision, floorBreached, false);
  }
  if (baseInput.pressure.verdict !== "take-more-work") {
    return toFloorAwareAction(ordinaryDecision, floorBreached, false);
  }
  const forcedDecision = decideAutoscaleAction({
    ...baseInput,
    capacity: hardMaximum,
  });
  return toFloorAwareAction(
    forcedDecision,
    floorBreached,
    forcedDecision.action === "spawn",
  );
}

function toFloorAwareAction(
  decision: AutoscaleAction,
  floorBreached: boolean,
  floorOverride: boolean,
): FloorAwareAutoscaleAction {
  if (decision.action === "spawn") {
    return { action: "spawn", candidate: decision.candidate, floorOverride };
  }
  if (decision.action === "unresolved") {
    return { action: "unresolved", name: decision.name, floorBreached };
  }
  return {
    action: "skip",
    reason: decision.reason,
    floorBreached,
    noLaunchableWork: decision.noLaunchableWork,
  };
}
