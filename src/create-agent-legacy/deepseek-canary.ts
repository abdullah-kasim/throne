import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import type { ObjectiveContract } from "../shared-policy/objective-contract.ts";
import type { HarnessUsage } from "../harness-routing/policy/usage.ts";
import {
  activeTargetEffort,
  resolveTargetEffort,
  type ModelPair,
} from "../config.ts";

export const EXPLICIT_DEEPSEEK_CANARY_MODEL = "opencode-go/deepseek-v4-flash";

const EFFORT_RANGE = { min: 1, max: 6 } as const;

export function isExplicitDeepSeekAdmission(opts: {
  resuming: boolean;
  objectiveContract: ObjectiveContract | undefined;
  pair: ModelPair;
  role: string;
  bypassAlphaGuardrail: boolean;
  bypassPresetAgent: boolean;
  bypassModel: boolean;
}): boolean {
  if (
    opts.resuming ||
    opts.pair.harness !== HARNESS_NAMES.CODEXY_ALL_OMNI ||
    opts.pair.model !== EXPLICIT_DEEPSEEK_CANARY_MODEL
  ) {
    return false;
  }
  if (opts.objectiveContract?.kind === "non-campaign") return true;
  return (
    opts.objectiveContract?.kind === "campaign" &&
    opts.role.trim().toLowerCase() === "alpha" &&
    opts.bypassAlphaGuardrail &&
    opts.bypassPresetAgent &&
    opts.bypassModel
  );
}

export function resolveExplicitDeepSeekCanaryEffort(
  requestedEffort: number | undefined,
  targetEffort: number | undefined,
): number {
  return (
    requestedEffort ??
    resolveTargetEffort(targetEffort ?? activeTargetEffort(), EFFORT_RANGE)
  );
}

export function deepSeekTelemetryOverride(
  usage: HarnessUsage,
  bypassUnavailable: boolean,
  bypassZeroQuota: boolean,
): { admitted: boolean; exactZero: boolean; note: string } {
  const exactZero =
    usage.ok && (usage.weeklyPct === 0 || usage.sessionPct === 0);
  return {
    admitted: exactZero ? bypassZeroQuota : bypassUnavailable,
    exactZero,
    note: exactZero
      ? "--bypass-zero-quota admitted trustworthy exact-zero OpenCode telemetry"
      : "--bypass-opencode-telemetry-unavailable admitted unusable OpenCode telemetry",
  };
}
