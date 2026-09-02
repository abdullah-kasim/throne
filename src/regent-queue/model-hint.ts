import { canonicalForwardModelPair, type ModelPair } from "../config.ts";

export function parseQueueModelHint(value: string | undefined): ModelPair | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const [harness, model, extra] = value.trim().split("/");
  if (harness === undefined || model === undefined || extra !== undefined) {
    throw new Error(`model hint must be a harness/model pair: ${value}`);
  }
  const pair = canonicalForwardModelPair({ harness: harness as ModelPair["harness"], model });
  if (pair === undefined) throw new Error(`model hint is not mechanically spawnable: ${value}`);
  return pair;
}
