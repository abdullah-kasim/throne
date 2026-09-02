import type { ModelSteer } from "./model-steering.shared.ts";
import type { SteerInput } from "./steering.types.ts";

/** A requested mechanically-admitted Alpha route stays selected. Humans choose
 * a different pair through the preset, an allowlist, or authorization. */
export function resolveAlphaModelSteer(input: SteerInput): ModelSteer {
  return {
    kind: "pick",
    pair: input.requested,
    note: "preset-selected Alpha route kept as requested",
  };
}
