import type { Harness } from '../harness-routing/harness.ts';
import {
  activeTargetEffort,
  resolveTargetEffort,
} from '../config.ts';
import { modelEffortRange } from './legacy-capabilities.ts';
import { resolveModelSteer } from './legacy-model-steering.ts';
import type {
  SteerInput,
  SteerRefusal,
  SteerResult,
} from '../harness-routing/policy/steering.types.ts';

export function resolveFreshEffort(opts: {
  harness: Harness;
  model: string;
  requestedEffort?: number;
  bypassEffort: boolean;
  targetEffort?: number;
}): { kind: 'effort'; effort: number; overrideNote?: string } | SteerRefusal {
  const target = opts.targetEffort ?? activeTargetEffort();
  const range = modelEffortRange(opts.harness, opts.model);
  if (range === undefined) {
    return {
      kind: 'refuse',
      steer: 'effort',
      message:
        `no effort range is registered for ${opts.harness}/${opts.model}, so ` +
        `its ordinary fresh effort cannot be resolved`,
    };
  }
  const ordinary = resolveTargetEffort(target, range);
  if (opts.requestedEffort === undefined || opts.requestedEffort === ordinary) {
    return { kind: 'effort', effort: ordinary };
  }
  if (opts.bypassEffort) {
    return {
      kind: 'effort',
      effort: opts.requestedEffort,
      overrideNote:
        `--bypass-effort overrode the fresh ${opts.harness}/${opts.model} ` +
        `effort steer for this one spawn (requested portable effort ` +
        `${opts.requestedEffort}; ordinary effort ${ordinary} from target ` +
        `effort ${target})`,
    };
  }
  return {
    kind: 'refuse',
    steer: 'effort',
    message:
      `the fresh-effort steer resolves every new ${opts.harness}/${opts.model} ` +
      `spawn to portable effort ${ordinary} (target effort ${target} within its ` +
      `available range ${range.min}-${range.max}); requested effort ` +
      `${opts.requestedEffort} diverges. Omit --effort, request ${ordinary}, ` +
      `or pass --bypass-effort to force effort ${opts.requestedEffort}`,
  };
}

export function steerSpawn(input: SteerInput): SteerResult {
  const modelSteer = resolveModelSteer(input);
  if (modelSteer.kind === 'refuse') return modelSteer;

  const effort = resolveFreshEffort({
    harness: modelSteer.pair.harness,
    model: modelSteer.pair.model,
    requestedEffort: input.requestedEffort,
    bypassEffort: input.bypass.effort,
    targetEffort: input.targetEffort,
  });
  if (effort.kind === 'refuse') return effort;

  return {
    kind: 'launch',
    harness: modelSteer.pair.harness,
    model: modelSteer.pair.model,
    effort: effort.effort,
    note: modelSteer.note,
    ...(modelSteer.durableRoutingNote === true
      ? { durableRoutingNote: true as const }
      : {}),
    ...(modelSteer.desperation === true
      ? { desperation: true as const }
      : {}),
    ...(effort.overrideNote === undefined
      ? {}
      : { effortOverrideNote: effort.overrideNote }),
  };
}
