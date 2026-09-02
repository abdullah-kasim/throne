import { HARNESS_NAMES } from '../harness.ts';
import { resolveShadowLaunch } from './admission.ts';
import {
  openCodeTelemetryVerdict,
  pairLabel,
  poolLabel,
  type ModelSteer,
} from './model-steering.shared.ts';
import type { SteerInput } from './steering.types.ts';

export function resolveExecutionShadowModelSteer(
  input: SteerInput,
): ModelSteer {
  const requested = input.requested;
  if (requested.harness === HARNESS_NAMES.OPENCODE) {
    const verdict = openCodeTelemetryVerdict({
      usage: input.usage?.opencode,
      bypassZeroQuota: input.bypass.zeroQuota,
    });
    if (verdict.kind === 'refuse') {
      return {
        kind: 'refuse',
        steer: 'usage',
        message: `the opencode-go usage steer refused the spawn: ${verdict.reason}`,
      };
    }
    if (input.bypass.usage) {
      return {
        kind: 'pick',
        pair: requested,
        note: `${verdict.note}; --bypass-usage kept the explicitly requested route`,
        durableRoutingNote: true,
      };
    }
    return {
      kind: 'pick',
      pair: requested,
      note: verdict.note,
      durableRoutingNote: true,
    };
  }
  const plan = resolveShadowLaunch({
    role: 'shadow',
    req: requested,
    usage: input.usage,
    isValidateGate: false,
    allowedPairs: input.allowedPairs,
  });
  if (plan.kind === 'launch') {
    return {
      kind: 'pick',
      pair: { harness: plan.harness, model: plan.model },
      note: plan.note,
    };
  }
  return {
    kind: 'refuse',
    steer: 'usage',
    message: `the execution-shadow usage steer ${
      plan.kind === 'pause' ? 'paused the spawn' : 'could not remap the model'
    }: ${plan.reason}`,
  };
}
