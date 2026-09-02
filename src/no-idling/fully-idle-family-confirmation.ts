import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import type { IdentityLineRead } from '../agentdata/identity-data.service.ts';
import { NO_IDLING_ALPHA_ROLE, hasRawLiveChildren } from './idle-family.ts';
import type { ConfirmedObservationTracker } from './confirmed-observation.ts';

/**
 * Confirms, per Alpha, whether "this Alpha currently has zero raw live
 * children" has now held across two consecutive sweeps with no intervening
 * ledger motion — the fix for FP2 (`idle-family.ts`'s
 * `confirmedNoLiveChildrenAlphaNames` doc comment has the full defect
 * writeup: alpha-lnb-lane-budget/alpha-nid-no-indeterminate were flagged
 * "fully idle" while a live Shadow was working, because a single roster
 * snapshot transiently read as childless).
 *
 * The caller (`no-idling-run.ts`) computes this once per sweep tick and
 * reuses the result across both of its `findFullyIdleFamilies` calls so a
 * single tick is never recorded as two separate observations against
 * `tracker`.
 */
export function confirmNoLiveChildrenAlphaNames(
  roster: readonly AgentStatusesRosterEntry[],
  supervisors: ReadonlyMap<string, IdentityLineRead>,
  tracker: ConfirmedObservationTracker,
): ReadonlySet<string> {
  const confirmed = new Set<string>();
  for (const alpha of roster) {
    if (alpha.role !== NO_IDLING_ALPHA_ROLE) {
      continue;
    }
    const hasNoLiveChildren = !hasRawLiveChildren(alpha.name, { roster, supervisors });
    const isConfirmed = tracker.recordObservation(
      `fully-idle-family-no-live-children:${alpha.name}`,
      hasNoLiveChildren,
      false,
    );
    if (isConfirmed) {
      confirmed.add(alpha.name);
    }
  }
  return confirmed;
}
