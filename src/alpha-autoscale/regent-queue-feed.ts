import { ACTIVE_PLAN_PRESET, resolvePlanPreset } from "../config.ts";
import {
  openRegentQueueStore,
  type QueueLaunchBriefRow,
  type RegentQueueLaunchBriefStore,
  type RegentQueueItemRow,
} from "../regent-queue/regent-queue.store.ts";
import type {
  LaunchQueueCandidate,
  ReadyQueueResult,
} from "../alpha-launch-queue/ready-queue.ts";
import { isCanonicalRegentAuthority } from "../shared-policy/regent-authority.ts";
import {
  classifyEffectiveQueueDecision,
  orderQueueItemsForDispatch,
} from "../regent-queue/regent-queue-dispatch.ts";
import { isTokenBalanceKillSwitchOn } from "../token-balance/token-balance-kill-switch.ts";
import { isTokenBalanceEnabled } from "../steering-user-config.ts";
import {
  collectTokenBalanceReport,
  readUsageLogRowsOrEmpty,
} from "../token-balance/token-balance.command.ts";
import type { LaneBalanceVerdict } from "../token-balance/token-balance-report.ts";

export const ALPHA_AUTOSCALE_AUTHORITY = "alpha-autoscale" as const;

/** Chooses which lane's `{harness, model}` pair an automatic Alpha launch
 *  should use. Both the ship-dark kill switch and the durable operator
 *  setting must be on for the balancer to have any say; either being off
 *  reproduces today's hardcoded `ACTIVE_PLAN_PRESET.rolePools.Alpha[0]`
 *  route exactly. Injectable so tests can drive every branch without a real
 *  usage log or `config.user.ts`. */
export interface AutoscaleAlphaRouteDeps {
  readonly tokenBalanceKillSwitchOn: () => boolean;
  readonly tokenBalanceOperatorEnabled: () => boolean;
  readonly tokenBalanceVerdict: () => LaneBalanceVerdict;
}

const REAL_AUTOSCALE_ALPHA_ROUTE_DEPS: AutoscaleAlphaRouteDeps = {
  tokenBalanceKillSwitchOn: () => isTokenBalanceKillSwitchOn(),
  tokenBalanceOperatorEnabled: () => isTokenBalanceEnabled(),
  tokenBalanceVerdict: () =>
    collectTokenBalanceReport(readUsageLogRowsOrEmpty()).verdict,
};

/** The automatic Alpha launch route this tick should use, or the reason no
 *  route is available -- unlike `create-agent`'s entrance gate, a blocked
 *  token-balance verdict is never an error here, only a missing route. */
export type AutoscaleAlphaRoute =
  | { readonly available: true; readonly harness: string; readonly model: string }
  | { readonly available: false; readonly reason: string };

function hardcodedActivePresetAlphaRoute(): AutoscaleAlphaRoute {
  const route = ACTIVE_PLAN_PRESET.rolePools.Alpha[0];
  return route === undefined
    ? { available: false, reason: "active model policy has no Alpha route" }
    : { available: true, harness: route.harness, model: route.model };
}

/**
 * The route an automatic Alpha launch candidate should use this tick: the
 * hardcoded active-preset route when the token-balance kill switch or the
 * operator setting is off (today's behavior, unchanged), or the token-lane
 * balancer's chosen lane's route when both are on. Never refuses -- a
 * blocked verdict (both lanes disqualified) reports no route with the
 * reason instead of throwing, so a caller simply produces no launch
 * candidate for that tick.
 */
export function resolveAutoscaleAlphaRoute(
  deps: AutoscaleAlphaRouteDeps = REAL_AUTOSCALE_ALPHA_ROUTE_DEPS,
): AutoscaleAlphaRoute {
  if (!deps.tokenBalanceKillSwitchOn() || !deps.tokenBalanceOperatorEnabled()) {
    return hardcodedActivePresetAlphaRoute();
  }
  const verdict = deps.tokenBalanceVerdict();
  if (verdict.blocked) {
    return {
      available: false,
      reason: `token-balance blocked: ${verdict.reason}`,
    };
  }
  const route = resolvePlanPreset(verdict.chosenLane).rolePools.Alpha[0];
  return route === undefined
    ? {
        available: false,
        reason: `token-balance chosen lane "${verdict.chosenLane}" has no Alpha route`,
      }
    : { available: true, harness: route.harness, model: route.model };
}

export type AutoBriefResult =
  | { readonly state: "staged"; readonly count: number }
  | { readonly state: "ineligible"; readonly reasons: string[] }
  | { readonly state: "unknown"; readonly reason: string };

function effectiveIneligibilityReason(item: RegentQueueItemRow): string {
  const decision = classifyEffectiveQueueDecision(item);
  return decision.state === "eligible"
    ? (item.launchEligibility?.reason ?? "launch eligibility unknown")
    : decision.reason;
}

function structurallyValidBrief(brief: QueueLaunchBriefRow): boolean {
  return (
    brief.lifecycle === "active" &&
    [
      brief.objectiveCode,
      brief.canonicalName,
      brief.targetRepo,
      brief.targetBranch,
      brief.baseCommit,
    ].every((value) => value.trim() !== "")
  );
}

function matchingAutoscaleBrief(
  brief: QueueLaunchBriefRow,
  item: RegentQueueItemRow,
): boolean {
  const eligibility = item.launchEligibility;
  return (
    brief.authorizer === ALPHA_AUTOSCALE_AUTHORITY &&
    eligibility?.eligible === true &&
    brief.objectiveCode === item.objectiveCode &&
    brief.canonicalName === eligibility.alphaName &&
    brief.targetRepo === eligibility.targetRepo &&
    brief.targetBranch === eligibility.targetBranch &&
    brief.baseCommit === eligibility.baseCommit
  );
}

export function stageEligibleLaunchBriefs(
  store: RegentQueueLaunchBriefStore,
): AutoBriefResult {
  const queue = store.readAll();
  if (queue.state === "unknown") return queue;
  if (queue.state === "positively-empty") return { state: "staged", count: 0 };
  const openItems = orderQueueItemsForDispatch(
    queue.items.filter((item) => item.status === "open"),
  );
  // A queue whose every row is non-open (complete, dismissed, archived) has
  // nothing to brief and nothing to call ineligible. Before 2026-09-02 this
  // fell through to `ineligible` with an EMPTY reason list, and the worker
  // logged "auto-brief found ineligible items: " with nothing after the
  // colon -- a claim with no subject. Observed on the live Mac the tick
  // after the first `hiregent` row went complete.
  if (openItems.length === 0) return { state: "staged", count: 0 };
  const eligibleItems = openItems.filter(
    (item) =>
      classifyEffectiveQueueDecision(item).state === "eligible" &&
      item.launchEligibility?.eligible === true,
  );
  const ineligibleReasons = [
    ...new Set(
      openItems
        .filter((item) => !eligibleItems.includes(item))
        .map(effectiveIneligibilityReason),
    ),
  ];
  try {
    for (const item of eligibleItems) {
      const eligibility = item.launchEligibility!;
      store.stageLaunchBrief({
        objectiveCode: item.objectiveCode!,
        canonicalName: eligibility.alphaName!,
        targetRepo: eligibility.targetRepo!,
        targetBranch: eligibility.targetBranch!,
        baseCommit: eligibility.baseCommit!,
        authorizer: ALPHA_AUTOSCALE_AUTHORITY,
      });
    }
  } catch (error) {
    return {
      state: "unknown",
      reason: `eligible launch briefing failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return eligibleItems.length > 0
    ? { state: "staged", count: eligibleItems.length }
    : { state: "ineligible", reasons: ineligibleReasons };
}

export function stageEligibleLaunchBriefsFromStore(): AutoBriefResult {
  const store = openRegentQueueStore();
  try {
    return stageEligibleLaunchBriefs(store);
  } finally {
    store.close();
  }
}

export function readAutoscaleQueue(
  store: RegentQueueLaunchBriefStore,
  autoscaleAlphaRouteDeps: AutoscaleAlphaRouteDeps = REAL_AUTOSCALE_ALPHA_ROUTE_DEPS,
): ReadyQueueResult {
  const queue = store.readAll();
  if (queue.state === "unknown") return queue;
  if (queue.state === "positively-empty") return { state: "positively-empty" };
  const openItems = orderQueueItemsForDispatch(
    queue.items.filter((item) => item.status === "open"),
  );
  // Same guard as `stageEligibleLaunchBriefs`: no open rows is positively
  // empty, whatever launch briefs may linger, never `ineligible` for no
  // stated reason.
  if (openItems.length === 0) return { state: "positively-empty" };
  const decisionByObjective = new Map(
    openItems.map((item) => [
      item.objectiveCode,
      classifyEffectiveQueueDecision(item),
    ]),
  );
  const result = store.readLaunchBriefs();
  if (result.state === "unknown") return result;
  if (result.state === "positively-empty") {
    return openItems.length === 0
      ? { state: "positively-empty" }
      : {
          state: "ineligible",
          reasons: [...new Set(openItems.map(effectiveIneligibilityReason))],
        };
  }
  const activeBriefs = result.briefs.filter(
    (brief) => brief.lifecycle === "active",
  );
  const itemByObjective = new Map(
    openItems.map((item) => [item.objectiveCode, item]),
  );
  const unauthorized = activeBriefs.find((brief) => {
    const item = itemByObjective.get(brief.objectiveCode);
    return (
      !isCanonicalRegentAuthority(brief.authorizer) &&
      !(item !== undefined && matchingAutoscaleBrief(brief, item))
    );
  });
  if (unauthorized !== undefined) {
    return {
      state: "unknown",
      reason: `active launch brief for "${unauthorized.objectiveCode}" is unauthorized: authorizer must be canonical Regent or a matching alpha-autoscale brief`,
    };
  }
  const invalid = activeBriefs.find((brief) => {
    const item = itemByObjective.get(brief.objectiveCode);
    return (
      !structurallyValidBrief(brief) ||
      (brief.authorizer === ALPHA_AUTOSCALE_AUTHORITY &&
        (item === undefined || !matchingAutoscaleBrief(brief, item)))
    );
  });
  if (invalid !== undefined) {
    return {
      state: "unknown",
      reason: `active launch brief for "${invalid.objectiveCode}" is structurally invalid`,
    };
  }
  const routeConsult = resolveAutoscaleAlphaRoute(autoscaleAlphaRouteDeps);
  if (!routeConsult.available)
    return { state: "unknown", reason: routeConsult.reason };
  const route = routeConsult;
  const briefByObjective = new Map(
    activeBriefs.map((brief) => [brief.objectiveCode, brief]),
  );
  const candidates: LaunchQueueCandidate[] = openItems
    .filter((item) => classifyEffectiveQueueDecision(item).state === "eligible")
    .map((item) => briefByObjective.get(item.objectiveCode ?? ""))
    .filter((brief): brief is QueueLaunchBriefRow => brief !== undefined)
    .map((brief) => ({
      name: brief.canonicalName,
      target: brief.targetRepo,
      dependencyReady: true,
      executableWork: true,
      harness: itemByObjective.get(brief.objectiveCode)?.modelHint?.harness ?? route.harness,
      model: itemByObjective.get(brief.objectiveCode)?.modelHint?.model ?? route.model,
      objectiveCode: brief.objectiveCode,
      targetRepo: brief.targetRepo,
      // PR-mode brief: the delivery target is the PR branch, and the recorded
      // mainline rides along so spawn-git-tree can create the branch (at the
      // authorized baseCommit) when it does not exist locally yet.
      targetBranch: brief.prBranch ?? brief.targetBranch,
      baseCommit: brief.baseCommit,
      ...(brief.prBranch === null
        ? {}
        : { createTargetFromBranch: brief.targetBranch }),
      objective: itemByObjective.get(brief.objectiveCode)?.body ?? "",
      modelHint: itemByObjective.get(brief.objectiveCode)?.modelHint ?? null,
      deliverableShape:
        itemByObjective.get(brief.objectiveCode)?.deliverableShape ?? null,
    }));
  return candidates.length === 0
    ? {
        state: "ineligible",
        reasons: [
          ...new Set(
            openItems.map((item) => {
              const decision = decisionByObjective.get(item.objectiveCode);
              return decision?.state === "eligible"
                ? effectiveIneligibilityReason(item)
                : (decision?.reason ?? "delivery evidence is unknown");
            }),
          ),
        ],
      }
    : { state: "candidates", candidates };
}

export function readAutoscaleQueueFromStore(): ReadyQueueResult {
  const store = openRegentQueueStore();
  try {
    return readAutoscaleQueue(store);
  } finally {
    store.close();
  }
}
