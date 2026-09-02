import type { ModelSteer } from "./model-steering.shared.ts";
import type { SteerInput } from "./steering.types.ts";

/** Gate route selection is explicit; it never chooses a stronger replacement. */
export function resolveGateModelSteer(input: SteerInput): ModelSteer {
  return {
    kind: "pick",
    pair: input.requested,
    note: "preset-selected gate route kept as requested",
  };
}
