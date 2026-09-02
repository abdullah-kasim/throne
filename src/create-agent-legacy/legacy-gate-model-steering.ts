import { highestCapabilityModel } from './legacy-capabilities.ts';
import { gateHarnessUsable, pairLabel, type ModelSteer } from '../harness-routing/policy/model-steering.shared.ts';
import type { SteerInput } from '../harness-routing/policy/steering.types.ts';

/** Gate model choice is driven by validation capability and current usage.
 * The supervisor's harness is context, never a model-policy wall. */
export function resolveGateModelSteer(input: SteerInput): ModelSteer {
  const harnesses = input.bypass.usage
    ? [input.requested.harness]
    : input.supervisorPair === undefined
      ? Object.keys(input.usage ?? {})
      : [input.supervisorPair.harness];
  const preferredHarness = harnesses.find((harness) =>
    gateHarnessUsable(input.usage?.[harness as keyof typeof input.usage]),
  );
  const candidate = preferredHarness === undefined
    ? undefined
    : highestCapabilityModel(preferredHarness as SteerInput['requested']['harness'], input.allowedPairs, 'validation');
  if (candidate === undefined) {
    return { kind: 'pick', pair: input.requested, note: 'validation capability route had no usable candidate — kept requested model' };
  }
  const selected = { harness: candidate.harness, model: candidate.model };
  return {
    kind: 'pick',
    pair: selected,
    note: `validation capability ${candidate.score} with ${pairLabel(selected)}; harness usage remains independent`,
  };
}
