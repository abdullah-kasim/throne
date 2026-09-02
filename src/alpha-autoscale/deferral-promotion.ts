import {
  openRegentQueueStore,
  type RegentQueueStore,
} from "../regent-queue/regent-queue.store.ts";
import { RegentQueueItemStatus } from "../regent-queue/regent-queue-item-state.ts";
import type { RegentQueueItemRow } from "../regent-queue/regent-queue-row.ts";
import {
  idleRecoveryCandidates,
  releasableDeferrals,
} from "./deferral-release.ts";

/**
 * The autoscaler's pre-pass: it promotes held rows to `open` and then does
 * nothing else. Everything downstream — admission, pressure, cooldown, the
 * ledger check, the spawn itself — is untouched and unaware this ran, because
 * the only thing it changes is which rows the existing `status === "open"`
 * filter can see.
 *
 * Doing it as a promotion rather than a second spawn path is deliberate. A
 * recovery that launched agents directly would be a parallel launcher with its
 * own copy of every gate, and the copy would drift. This way there is still
 * exactly one way an Alpha is born.
 */

export interface DeferralPromotionOutcome {
  /** Rows released because their dependencies all finished. */
  readonly released: ReadonlyArray<{ objectiveCode: string; reason: string }>;
  /** The row idle recovery promoted, if it fired at all. */
  readonly recovered: string | null;
  /** Set when the recovered row had been held awaiting a named person, so the
   *  notice can say whose hold was overridden rather than losing that fact. */
  readonly overriddenAuthority: string | null;
}

export interface DeferralPromotionDeps {
  readonly openStore?: () => RegentQueueStore;
  readonly log?: (message: string) => void;
}

/**
 * Runs the release pass, and then idle recovery only if the release pass left
 * nothing launchable.
 *
 * "Nothing launchable" means no `open` row exists after releasing. The Lord's
 * ruling is that recovery is IMMEDIATE at that point, with no grace period:
 * once the queue is exhausted there is nothing left to wait for, so waiting is
 * pure loss. Recovery promotes exactly ONE row per tick — the highest-priority
 * candidate — rather than the whole held set, so an unattended court refills
 * gradually and the Regent has a tick between each to intervene.
 */
export function promoteDeferredWork(
  deps: DeferralPromotionDeps = {},
): DeferralPromotionOutcome {
  const store = (deps.openStore ?? openRegentQueueStore)();
  try {
    // A queue we cannot read is never a queue we may act on: an `unknown`
    // read must not look like "no held work" and must not look like "nothing
    // launchable" either, since the second would fire recovery blind.
    const readItems = (): RegentQueueItemRow[] | undefined => {
      const result = store.readAll();
      return result.state === "items" ? result.items : undefined;
    };
    const items = readItems();
    if (items === undefined) {
      return { released: [], recovered: null, overriddenAuthority: null };
    }
    const released = releasableDeferrals(items);
    for (const release of released) {
      const item = items.find(
        (candidate) => candidate.objectiveCode === release.objectiveCode,
      );
      if (item === undefined) continue;
      // transitionStatus, not a raw field write: it enforces the allowed
      // forward transitions, so a release that should not be legal fails here
      // rather than silently producing an impossible row.
      store.transitionStatus(item.id, RegentQueueItemStatus.Open);
      deps.log?.(
        `deferral released: "${release.objectiveCode}" — ${release.reason}`,
      );
    }
    const afterRelease = readItems() ?? items;
    const somethingLaunchable = afterRelease.some(
      (item) => item.status === RegentQueueItemStatus.Open,
    );
    if (somethingLaunchable) {
      return { released, recovered: null, overriddenAuthority: null };
    }
    const recovery = idleRecoveryCandidates(afterRelease);
    const target = recovery.launchable[0];
    if (target === undefined) {
      return { released, recovered: null, overriddenAuthority: null };
    }
    store.transitionStatus(target.id, RegentQueueItemStatus.Open);
    deps.log?.(
      `idle recovery: promoted held objective "${target.objectiveCode}" to open — ` +
        `the ready queue was exhausted and this row had no agent flying it`,
    );
    return {
      released,
      recovered: target.objectiveCode,
      overriddenAuthority: target.deferral?.releaseAuthority ?? null,
    };
  } finally {
    store.close();
  }
}

/** The Regent's notice when recovery fires. Recovery is a correct action taken
 *  in an ambiguous situation, so it announces itself in full rather than
 *  quietly resuming: the Regent held that row for a reason it may still hold,
 *  and it is the one that decides what happens next.
 *
 *  When the recovered row was held awaiting a PERSON, the notice says so
 *  explicitly. Recovery no longer exempts those rows: the Lord delegated his
 *  own authority to autoscale for exactly this case ("autoscale has my
 *  authority to do so"). It is still stated rather than silent, because a
 *  delegated decision that nobody can see is indistinguishable from a lost
 *  one, and the person who set the hold should learn that it was lifted. */
export function buildIdleRecoveryNotice(
  outcome: DeferralPromotionOutcome,
): string | undefined {
  if (outcome.recovered === null) return undefined;
  const override =
    outcome.overriddenAuthority === null
      ? ""
      : ` THIS ROW WAS HELD AWAITING ${outcome.overriddenAuthority.toUpperCase()}, ` +
        `and recovery launched it anyway. It does so WITH THE LORD'S OWN AUTHORITY, ` +
        `delegated to autoscale on 2026-08-25 — an exhausted queue is not a reason ` +
        `for the court to sit still. This is stated rather than silent so the ` +
        `decision surfaces as work: if that ruling is genuinely still needed before ` +
        `this proceeds, stop the Alpha and say so.`;
  return (
    `IDLE RECOVERY: the ready queue was exhausted with live work still held, so ` +
    `objective "${outcome.recovered}" was promoted to open and will launch. It ` +
    `had no agent flying it. If that hold was still wanted, defer it again now — ` +
    `update-queue --objective-code ${outcome.recovered} --status deferred — and ` +
    `give it a --depends-on so it releases itself when its real condition is ` +
    `met.${override}`
  );
}
