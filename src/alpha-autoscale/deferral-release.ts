import {
  RegentQueueItemStatus,
  TERMINAL_QUEUE_ITEM_STATUSES,
} from "../regent-queue/regent-queue-item-state.ts";
import type { RegentQueueItemRow } from "../regent-queue/regent-queue-row.ts";

/**
 * Two pure decisions the autoscaler makes before it looks at the ready queue,
 * both added on the Lord's order of 2026-08-25 after five objectives sat held
 * with no agent flying any of them and the court ran idle.
 *
 * FIRST, RELEASE (`releasableDeferrals`). A `deferred` row names the objective
 * codes it waits on. Once every one of them is terminal, the hold has served
 * its purpose and the row returns to `open` on the next tick. This is the half
 * that stops a satisfied condition going unnoticed: `gbpg` waited on the other
 * gabledge objectives, they all finished, and nothing was watching, so it sat
 * shut for hours while the court had nothing to do.
 *
 * SECOND, RECOVERY (`idleRecoveryCandidates`). If after releasing there is
 * still nothing launchable — no open row, nothing released this tick — the
 * court would otherwise idle indefinitely against work that exists. Recovery
 * then surfaces rows that are held with nobody flying them and lets them
 * launch, immediately, with no grace period: the Lord's ruling is that once
 * the queue is exhausted there is nothing left to wait FOR, so waiting is
 * pure loss. The Regent is told what recovery did and decides from there.
 *
 * RECOVERY HAS NO EXEMPTIONS (the Lord's order, 2026-08-25). It shipped with
 * one — a row naming a `releaseAuthority` was reported but never launched, on
 * the reasoning that an exhausted queue is a reason to ask him rather than
 * proceed without him. He overruled it within the hour, and the case that
 * killed it is worth recording, because it is the argument against the
 * exemption rather than merely a ruling about it.
 *
 * `olgp` was held awaiting his ruling on decision D6. The hold looked
 * principled and was not: spike S3, which was supposed to verify D6, had
 * failed for entirely mechanical reasons — a malformed FreeRDP argument and a
 * guest with no SSH service. That is unfinished agent work, not a judgement
 * anybody needed him for. The court had turned "a command line had bad quotes"
 * into "awaiting the Lord", and the exemption then guaranteed that four
 * objectives would sit untouched forever while the court ran idle.
 *
 * So the authority hold keeps its meaning where it is honest — the AUTOMATIC
 * release pass still never lifts it, because dependencies finishing genuinely
 * does not stand in for a person's ruling — and loses it where it was doing
 * harm. When there is nothing else left to run, a hold waiting on a human is
 * not more important than a court doing nothing. Recovery launches it and says
 * loudly that it did, naming the authority whose hold it overrode, so the
 * decision surfaces as work rather than as silence.
 */

/** A row is legitimately claimed only when an agent is actually named on it.
 *  An `in-flight` row with no agent is not work in progress; historically it
 *  was the only way to spell a hold, and those are exactly what recovery is
 *  for. */
export function isAgentlessInFlight(item: RegentQueueItemRow): boolean {
  return (
    item.status === RegentQueueItemStatus.InFlight && item.agentName === null
  );
}

function isTerminal(status: RegentQueueItemStatus): boolean {
  return TERMINAL_QUEUE_ITEM_STATUSES.has(status);
}

export interface DeferralRelease {
  readonly objectiveCode: string;
  readonly reason: string;
}

/**
 * Deferred rows whose dependencies have all reached a terminal status, highest
 * priority first. A row naming a `releaseAuthority` is never returned: that
 * hold is lifted by a person, not by a predicate.
 *
 * An unknown dependency code does NOT release the row. Fail closed: a typo, or
 * a dependency filed later, must read as "not satisfied yet" rather than
 * "nothing to wait for" — the opposite default would turn a misspelling into
 * an immediate launch.
 */
export function releasableDeferrals(
  items: readonly RegentQueueItemRow[],
): DeferralRelease[] {
  const statusByCode = new Map<string, RegentQueueItemStatus>();
  for (const item of items) {
    if (item.objectiveCode !== null) {
      statusByCode.set(item.objectiveCode.toLowerCase(), item.status);
    }
  }
  const released: Array<DeferralRelease & { priority: number }> = [];
  for (const item of items) {
    if (item.status !== RegentQueueItemStatus.Deferred) continue;
    if (item.objectiveCode === null) continue;
    const deferral = item.deferral;
    if (deferral === null) continue;
    if (deferral.releaseAuthority !== null) continue;
    if (deferral.dependsOn.length === 0) continue;
    const unmet = deferral.dependsOn.filter((code) => {
      const status = statusByCode.get(code);
      return status === undefined || !isTerminal(status);
    });
    if (unmet.length > 0) continue;
    released.push({
      objectiveCode: item.objectiveCode,
      priority: item.priority,
      reason:
        `every objective it waited on is terminal: ` +
        `${deferral.dependsOn.join(", ")}`,
    });
  }
  return released
    .sort((a, b) => b.priority - a.priority)
    .map(({ objectiveCode, reason }) => ({ objectiveCode, reason }));
}

export interface IdleRecovery {
  /** Rows recovery will launch, highest priority first. */
  readonly launchable: readonly RegentQueueItemRow[];
  /** Rows in `launchable` that were held awaiting a named person. Recovery
   *  launches them anyway; this exists so the notice can say whose hold was
   *  overridden, which is the difference between an override and a silent
   *  loss of a decision. */
  readonly overriddenAuthority: ReadonlyArray<{
    readonly objectiveCode: string;
    readonly authority: string;
  }>;
}

/**
 * What recovery may launch when the ready queue is exhausted. Callers must
 * only consult this once they know there is nothing ordinarily launchable;
 * this function does not re-derive that, so that the "are we actually idle?"
 * decision stays in one place at the call site.
 */
export function idleRecoveryCandidates(
  items: readonly RegentQueueItemRow[],
): IdleRecovery {
  const launchable: RegentQueueItemRow[] = [];
  const overriddenAuthority: Array<{
    objectiveCode: string;
    authority: string;
  }> = [];
  for (const item of items) {
    if (item.objectiveCode === null) continue;
    if (
      item.status !== RegentQueueItemStatus.Deferred &&
      !isAgentlessInFlight(item)
    ) {
      continue;
    }
    launchable.push(item);
    const authority = item.deferral?.releaseAuthority ?? null;
    if (authority !== null) {
      overriddenAuthority.push({
        objectiveCode: item.objectiveCode,
        authority,
      });
    }
  }
  launchable.sort((a, b) => b.priority - a.priority);
  return { launchable, overriddenAuthority };
}
