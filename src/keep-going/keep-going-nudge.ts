// Nudge decision logic for the keep-going heartbeat: the standing prompt
// text, the per-window throttle key, and reading the live usage-throttle
// signal. Reason to change: what the nudge says and when it is allowed to
// fire — not who gets nudged or how the message is delivered.

import type { FamilyRecoverySummary } from './keep-going-stalls.ts';
import type {
  HerdrAgent,
  KeepGoingDependencies,
  ThrottleBand,
  ThrottleEvaluation,
} from './keep-going-context.ts';
import {
  errText,
  KEEP_GOING_TICK_MS,
  UNTHROTTLED_EVALUATION,
  writeErr,
  writeOut,
} from './keep-going-context.ts';

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Render an instant in Malaysia time (MYT), a fixed UTC+8 offset with no DST:
 * shift the epoch by +8h, render the shifted instant's UTC fields ISO-like,
 * and suffix the explicit offset — e.g. `2026-07-22T09:20:45+08:00`. The
 * fixed offset IS the spec; never route this through Intl/timezone databases.
 */
export function formatMytTimestamp(date: Date): string {
  const shifted = new Date(date.getTime() + MYT_OFFSET_MS);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

/**
 * The Regent's standing instruction, prefixed with the current MYT time from
 * the injected clock (so the Regent can anchor queue timestamps and staleness
 * judgments), followed by the band advisory when — and only when — the
 * evaluated band is non-NORMAL. The advisory is the SOLE thing that may ever
 * be appended: it is how "slow down, never stop" reaches the Regent, not
 * narration.
 */
export function buildRegentNudgeText(
  now: () => Date,
  throttleBand: ThrottleBand,
  recoveryFamilies: readonly FamilyRecoverySummary[] = [],
): string {
  const stamped = `[${formatMytTimestamp(now())} MYT] run render-queue, queue and dispatch more work as necessary, check for stalled agents and poke them, and continue any active work`;
  const throttled = throttleBand.advisory === ''
    ? stamped
    : `${stamped} ${throttleBand.advisory}`;
  if (recoveryFamilies.length === 0) return throttled;
  const recoveryDetails = recoveryFamilies
    .map((family) => {
      const signatures = family.signatures
        .map((signature) => `${signature.child ?? signature.alpha} (${signature.reason})`)
        .join('; ');
      return `${family.alpha}: ${signatures}`;
    })
    .join(' | ');
  const blockedAlphas = recoveryFamilies
    .filter((family) =>
      family.signatures.some((signature) => signature.reason === 'blocked-alpha'),
    )
    .map((family) => family.alpha);
  const blockedMandate = blockedAlphas.length === 0
    ? ''
    : ` Blocked Alphas: ${blockedAlphas.join(', ')}. ` +
      'MANDATORY: independently double-check the current cause of each durable {"blocked":true} marker against its logs, evidence, dependencies, and quota state; resolve every cause within your authority; clear each stale or resolved blocked marker through throne tooling; and resume the Alpha. Report a precise externally-owned blocker only when the double-check proves you cannot remove it.';
  return (
    `${throttled} Recovery Alphas requiring Regent action: ${recoveryDetails}. ` +
    'Keep-going deliberately did not message these Alphas directly. This is actionable recovery work, not merely a heartbeat: independently inspect the evidence and prod each Alpha only when its current cause warrants a prod.' +
    blockedMandate
  );
}

export function keepGoingWindowKey(target: HerdrAgent, now: Date): string {
  return `keep-going:${target.name ?? target.paneId}:${Math.floor(now.getTime() / KEEP_GOING_TICK_MS)}`;
}

export async function evaluateLiveRegentThrottle(
  regentHarness: string,
  deps: KeepGoingDependencies,
): Promise<ThrottleEvaluation> {
  try {
    const evaluation = await deps.evaluateThrottle(regentHarness);
    if (evaluation.signal.status === 'unsupported') {
      writeOut(
        deps,
        `keep-going: live Regent harness "${regentHarness}" is unsupported for usage throttle — nudging unthrottled without reading a provider sensor.\n`,
      );
    }
    return evaluation;
  } catch (err) {
    writeErr(
      deps,
      `keep-going: throttle evaluation failed (${errText(err)}); nudging without throttle\n`,
    );
    return UNTHROTTLED_EVALUATION;
  }
}
