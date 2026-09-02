import { resolveAlphaModelSteer } from './alpha-model-steering.ts';
import { resolveExecutionShadowModelSteer } from './execution-shadow-model-steering.ts';
import { resolveGateModelSteer } from './gate-model-steering.ts';
import type { ModelSteer } from './model-steering.shared.ts';
import type { SteerInput } from './steering.types.ts';

function requestedPairForExplicitSteerBypass(
  input: SteerInput,
): ModelSteer | undefined {
  if (input.requested.harness === 'opencode' && input.role === 'shadow') {
    return undefined;
  }
  const modelBypassApplies =
    input.bypass.model && (input.role === 'alpha' || input.isValidateGate);
  const usageBypassApplies =
    input.bypass.usage && input.role === 'shadow' && !input.isValidateGate;
  if (!modelBypassApplies && !usageBypassApplies) {
    return undefined;
  }
  const bypassFlag = modelBypassApplies ? '--bypass-model' : '--bypass-usage';
  return {
    kind: 'pick',
    pair: input.requested,
    note: `${bypassFlag} kept the explicitly requested route`,
    durableRoutingNote: true,
  };
}

export function resolveModelSteer(input: SteerInput): ModelSteer {
  const explicitBypass = requestedPairForExplicitSteerBypass(input);
  if (explicitBypass !== undefined) return explicitBypass;
  if (input.role === 'alpha') return resolveAlphaModelSteer(input);
  if (input.isValidateGate) return resolveGateModelSteer(input);
  return resolveExecutionShadowModelSteer(input);
}
