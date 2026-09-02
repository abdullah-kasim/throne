import { Injectable } from "@nestjs/common";
import {
  type ActivePlanStatus,
  type ForwardLaunchPolicyStatus,
  type HarnessEntry,
  type ModelEntry,
} from "./harness-catalog.contracts.ts";
import {
  ACTIVE_PLAN_PRESET,
  GPT_FORWARD_HARNESS,
  activePlanPresetName,
  activeTargetEffort,
  resolveTargetEffort,
} from "../config.ts";
import {
  HARNESS_NAMES,
  HARNESSES,
  MODEL_NAMES,
  isGptModel,
  launcherFamily,
  modelsForHarness,
  type Harness,
} from "../harness-routing/harness.ts";
import {
  MODEL_REGISTRY,
  registryEntry,
} from "../harness-routing/model-registry.ts";
import { modelEffortRange } from "../harness-routing/policy/capabilities.ts";
import { omniLauncherForHarness } from "../harness-routing/omni-routing.ts";

function launcherFor(harness: Harness, model: string): string {
  const omni = omniLauncherForHarness(harness);
  if (omni !== undefined) return omni;
  if (harness === HARNESS_NAMES.CODEX) return "codexy";
  if (harness === HARNESS_NAMES.OPENCODE) return "opencodey";
  return isGptModel(model) ? "claudey-all" : "claudey";
}

function buildRegistry(): HarnessEntry[] {
  return HARNESSES.map((harness) => ({
    harness,
    models: [
      ...modelsForHarness(harness).map((model) => {
        const range = modelEffortRange(harness, model);
        const launchPolicy: ModelEntry["launchPolicy"] =
          registryEntry(model)?.enabled === false
            ? "registered-resume-only"
            : isGptModel(model) && harness !== GPT_FORWARD_HARNESS
              ? "new-with-bypass-or-registered"
              : "new-and-registered";
        return {
          model,
          launcher: launcherFor(harness, model),
          launchPolicy,
          spawnability: "mechanically-spawnable" as const,
          effortMin: range?.min ?? null,
          effortMax: range?.max ?? null,
          ordinaryEffort: range
            ? resolveTargetEffort(activeTargetEffort(), range)
            : null,
        };
      }),
      ...MODEL_REGISTRY.filter(
        (entry) => entry.harness === harness && !entry.enabled,
      ).map((entry) => ({
        model: entry.model,
        launcher: launcherFor(harness, entry.model),
        launchPolicy: "registered-resume-only" as const,
        spawnability: "registered-resume-only" as const,
        effortMin: entry.effort.min,
        effortMax: entry.effort.max,
        ordinaryEffort: entry.effort.ordinary,
      })),
    ],
  }));
}

/** Nest owner for the executable harness/model registry and routing summary. */
@Injectable()
export class HarnessRegistryService {
  entries(): HarnessEntry[] {
    return buildRegistry();
  }

  activePlan(): ActivePlanStatus {
    return {
      preset: activePlanPresetName(),
      rolePools: ACTIVE_PLAN_PRESET.rolePools,
    };
  }

  forwardLaunchPolicy(): ForwardLaunchPolicyStatus {
    const gptLauncher = launcherFamily(
      GPT_FORWARD_HARNESS,
      MODEL_NAMES.GPT_5_6_SOL,
    );
    return {
      gptHarness: GPT_FORWARD_HARNESS,
      gptLauncher,
      description: `Fresh eligible GPT-model agents use ${GPT_FORWARD_HARNESS} via ${gptLauncher}, per MODEL_REGISTRY.`,
    };
  }
}
