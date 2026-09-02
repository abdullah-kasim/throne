/**
 * A single instantaneous sample cannot distinguish "not moving yet" from
 * "not moving anymore" from "not moving ever" from "designed never to
 * move". This module is the one shared home for the resulting decision:
 * a subject (a tab label, an Alpha's family, an agent's blocked
 * transition) is confirmed not-recovering only once it has been observed
 * in the same still-idle/still-blocked/still-stale state across at least
 * two consecutive samples, with no ledger motion (the underlying evidence
 * source going live, or otherwise changing, between those samples).
 *
 * Every consumer calls `ConfirmedObservationTracker.recordObservation`;
 * none re-derives this decision inline.
 */

/**
 * Pure step: given whether the subject already had one matching
 * observation pending (with no motion since), and this sample's own
 * still-matching/ledger-motion signals, decides whether the subject is now
 * confirmed and what streak state to carry into the next observation.
 *
 * A non-matching sample or intervening ledger motion both end the current
 * streak outright — motion means the evidence changed between samples, so
 * whatever streak was accumulating belongs to a now-closed episode and must
 * never carry into a later, unrelated one.
 */
export function decideConfirmation(
  hasPendingMatch: boolean,
  isStillMatching: boolean,
  ledgerMotionSinceLastObservation: boolean,
): { confirmed: boolean; nextHasPendingMatch: boolean } {
  if (!isStillMatching || ledgerMotionSinceLastObservation) {
    return { confirmed: false, nextHasPendingMatch: false };
  }
  return { confirmed: hasPendingMatch, nextHasPendingMatch: true };
}

/**
 * Keyed, process-lifetime, in-memory store around `decideConfirmation`.
 * In-memory is sufficient: the sweeps/workers holding one instance are
 * themselves long-lived, and a restart resets every subject to "not yet
 * confirmed" — the safe failure direction (a delayed real notice), never a
 * fabricated one. No concrete cross-restart requirement was found for any
 * of this bundle's three call sites.
 */
export class ConfirmedObservationTracker {
  private readonly pendingMatches = new Map<string, boolean>();

  /**
   * Records one sample for `subjectKey` and returns whether it is now
   * confirmed — true only on the second (or later) consecutive matching
   * sample with no intervening ledger motion.
   */
  recordObservation(
    subjectKey: string,
    isStillMatching: boolean,
    ledgerMotionSinceLastObservation: boolean,
  ): boolean {
    const { confirmed, nextHasPendingMatch } = decideConfirmation(
      this.pendingMatches.get(subjectKey) === true,
      isStillMatching,
      ledgerMotionSinceLastObservation,
    );
    if (nextHasPendingMatch) {
      this.pendingMatches.set(subjectKey, true);
    } else {
      this.pendingMatches.delete(subjectKey);
    }
    return confirmed;
  }
}
