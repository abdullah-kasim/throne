import type { Harness } from "../harness-routing/harness.ts";
import type { PlanPresetName, PlanRolePools } from "../config.ts";

export interface ModelEntry {
  model: string;
  launcher: string;
  launchPolicy:
    | "new-and-registered"
    | "new-with-bypass-or-registered"
    | "registered-resume-only";
  spawnability: "mechanically-spawnable" | "registered-resume-only";
  effortMin: number | null;
  effortMax: number | null;
  ordinaryEffort: number | null;
}
export interface HarnessEntry {
  harness: Harness;
  models: ModelEntry[];
}
export interface ActivePlanStatus {
  preset: PlanPresetName;
  rolePools: PlanRolePools;
}
export interface ForwardLaunchPolicyStatus {
  gptHarness: Harness;
  gptLauncher: string;
  description: string;
}
