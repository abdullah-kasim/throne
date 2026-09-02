import { highestCapabilityModel } from './legacy-capabilities.ts';
import { pairLabel, type ModelSteer } from '../harness-routing/policy/model-steering.shared.ts';
import type { SteerInput } from '../harness-routing/policy/steering.types.ts';

/** Alpha selection uses capability and usage metrics; no named pair is
 * privileged, reserved, or refused. Harness selection stays a separate route. */
export function resolveAlphaModelSteer(input: SteerInput): ModelSteer {
  const requestedHarness = input.requested.harness;
  const usage = input.usage?.[requestedHarness as keyof typeof input.usage];
  const candidate = highestCapabilityModel(requestedHarness, input.allowedPairs, 'planning');
  if (candidate === undefined) {
    return { kind: 'pick', pair: input.requested, note: 'planning capability unavailable — kept requested model' };
  }
  const selected = { harness: candidate.harness, model: candidate.model };
  const usageNote = usage?.ok && usage.weeklyPct !== undefined
    ? `; harness usage ${usage.weeklyPct}% remaining`
    : '; harness usage unavailable';
  return {
    kind: 'pick',
    pair: selected,
    note: `planning capability ${candidate.score} selected ${pairLabel(selected)}${usageNote}`,
  };
}
