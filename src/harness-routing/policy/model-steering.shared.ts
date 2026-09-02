import type { ModelPair, ModelPairPool } from '../../config.ts';
import {
  describeUnusableHarnessUsage,
  isHarnessUsageUsable,
  type HarnessUsage,
} from './usage.ts';
import type { SteerRefusal } from './steering.types.ts';

export type ModelSteer =
  | {
      kind: 'pick';
      pair: ModelPair;
      note: string;
      desperation?: true;
      durableRoutingNote?: true;
    }
  | SteerRefusal;

export function pairLabel(pair: ModelPair): string {
  return `${pair.harness}/${pair.model}`;
}

export function poolLabel(pool: ModelPairPool): string {
  return pool.map(pairLabel).join(', ');
}

export function harnessWeeklyUsable(
  usage: HarnessUsage | undefined,
): boolean {
  return (
    usage !== undefined &&
    usage.ok &&
    usage.weeklyPct !== undefined &&
    usage.weeklyPct > 0
  );
}

export function gateHarnessUsable(
  usage: HarnessUsage | undefined,
): boolean {
  return usage !== undefined && isHarnessUsageUsable(usage);
}

export type OpenCodeTelemetryVerdict =
  | { kind: 'admit'; note: string }
  | { kind: 'refuse'; reason: string };

/** The opencode-go usage gate for a requested opencode pair. Unavailable
 *  telemetry degrades admission with a recorded note; a readable exhausted
 *  reading refuses unless `--bypass-zero-quota` overrides that exact zero. */
export function openCodeTelemetryVerdict(opts: {
  usage: HarnessUsage | undefined;
  bypassZeroQuota: boolean;
}): OpenCodeTelemetryVerdict {
  const usage = opts.usage;
  if (usage === undefined || !usage.ok) {
    return {
      kind: 'admit',
      note:
        'opencode-go telemetry unavailable — degraded admission launches the ' +
        'requested opencode pair',
    };
  }
  if (isHarnessUsageUsable(usage)) {
    return {
      kind: 'admit',
      note:
        `opencode-go telemetry weekly ${usage.weeklyPct}% remaining — ` +
        'launching the requested opencode pair',
    };
  }
  const exactZero = usage.weeklyPct === 0 || usage.sessionPct === 0;
  if (opts.bypassZeroQuota && exactZero) {
    return {
      kind: 'admit',
      note:
        '--bypass-zero-quota admitted trustworthy exact-zero OpenCode ' +
        'telemetry — launching the requested opencode pair',
    };
  }
  return {
    kind: 'refuse',
    reason:
      `opencode-go telemetry is ${describeUnusableHarnessUsage(usage, false)}; ` +
      'fresh, semantically complete, positive remaining quota is mandatory. ' +
      'Pass --bypass-zero-quota to admit a deliberate exact-zero launch',
  };
}
