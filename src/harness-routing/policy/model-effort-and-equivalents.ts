import {
  runtimeHarness,
  type Harness,
  type RuntimeHarness,
} from "../harness.ts";
import { configuredModelCandidate, type ModelPairPool } from "../../config.ts";
import { MODEL_REGISTRY } from "../model-registry.ts";
import { deriveEffortRanges } from "../registry-derivation.ts";
import { isModelPairAllowed } from "./admission.ts";

const EFFORT_RANGES = deriveEffortRanges(MODEL_REGISTRY);

const EQUIVALENT_MODELS: readonly Partial<Record<RuntimeHarness, string>>[] = [
  { claude: "haiku", codex: "gpt-5.4-mini" },
  { claude: "sonnet", codex: "gpt-5.4" },
  { claude: "opus", codex: "gpt-5.6-sol" },
  { claude: "fable", codex: "gpt-5.6-sol" },
];

export function modelEffortRange(
  harness: Harness,
  model: string,
): { min: number; max: number } | undefined {
  const row = EFFORT_RANGES[runtimeHarness(harness)].find(
    (candidate) => candidate.model === model,
  );
  return row === undefined
    ? undefined
    : { min: row.effortMin, max: row.effortMax };
}

export function equivalentModel(
  model: string,
  from: Harness,
  to: Harness,
  allowedPairs?: ModelPairPool,
): string | undefined {
  if (from === to)
    return isModelPairAllowed(to, model, allowedPairs) ? model : undefined;
  const equivalent = EQUIVALENT_MODELS.find(
    (row) => row[runtimeHarness(from)] === model,
  )?.[runtimeHarness(to)];
  if (
    equivalent !== undefined &&
    isModelPairAllowed(to, equivalent, allowedPairs)
  )
    return equivalent;
  if (allowedPairs === undefined) return undefined;
  return configuredModelCandidate({ harness: to, model }) !== undefined &&
    isModelPairAllowed(to, model, allowedPairs)
    ? model
    : undefined;
}
