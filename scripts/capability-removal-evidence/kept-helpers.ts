import { HARNESSES } from "../../src/harness-routing/harness.ts";
import { MODEL_REGISTRY } from "../../src/harness-routing/model-registry.ts";
import { equivalentModel, modelEffortRange } from "../../src/harness-routing/policy/model-effort-and-equivalents.ts";
import type { ModelPairPool } from "../../src/config.ts";

const A_MIXED_POOL: ModelPairPool = [
  { harness: "claude", model: "opus" },
  { harness: "codex", model: "gpt-5.6-sol" },
  { harness: "codex", model: "gpt-5.4" },
];

export function keptHelperAnswers(): unknown[] {
  const harnesses = Object.values(HARNESSES);
  const models = [...new Set(MODEL_REGISTRY.map((row) => row.model))];
  const answers: unknown[] = [];
  for (const harness of harnesses) {
    for (const model of models) answers.push({ ask: "modelEffortRange", harness, model, answer: modelEffortRange(harness, model) ?? null });
  }
  for (const model of models) {
    for (const from of harnesses) {
      for (const to of harnesses) {
        answers.push({ ask: "equivalentModel", model, from, to, pool: "none", answer: equivalentModel(model, from, to) ?? null });
        answers.push({ ask: "equivalentModel", model, from, to, pool: "mixed", answer: equivalentModel(model, from, to, A_MIXED_POOL) ?? null });
      }
    }
  }
  return answers;
}

if (import.meta.main) process.stdout.write(JSON.stringify(keptHelperAnswers()));
