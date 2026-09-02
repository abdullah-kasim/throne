import type {
  QueueAbsorption,
  RegentQueueItemRow,
} from "./regent-queue.store.ts";

export type EffectiveQueueDecision =
  | {
      readonly state: "eligible";
      readonly reason: "not absorbed by another objective";
    }
  | {
      readonly state: "ineligible";
      readonly reason: string;
      readonly annotation: "ABSORBED-PENDING" | "DELIVERED-PENDING-REAP";
    }
  | { readonly state: "unknown"; readonly reason: string };

export function isActiveQueueAbsorption(
  absorption: QueueAbsorption | null,
): boolean {
  return (
    absorption !== null &&
    absorption.reason === null &&
    absorption.objectiveCode.trim() !== "" &&
    absorption.checkedAt !== null
  );
}

export function classifyEffectiveQueueDecision(
  item: RegentQueueItemRow,
): EffectiveQueueDecision {
  if (isActiveQueueAbsorption(item.absorption)) {
    return {
      state: "ineligible",
      annotation: "ABSORBED-PENDING",
      reason: `absorbed by ${item.absorption!.objectiveCode}`,
    };
  }
  if (item.absorption !== null) {
    return {
      state: "unknown",
      reason: item.absorption.reason ?? "absorption evidence is unknown",
    };
  }
  // The delivery mirror deliberately does NOT participate here (Lord,
  // 2026-08-21: "we dropped the delivery commit -- remove the requirement,
  // we don't care about the delivery commit anymore"). Absorption is the
  // only thing that can make a row ineligible now.
  //
  // Two things went with it, stated rather than left to be discovered.
  // First, the queue no longer inspects git to notice that a row already
  // landed, so it no longer refuses to re-dispatch a delivered objective --
  // closing a row is the Regent's write-back, not an inference from the
  // repository. Second, the removed `not-started` branch is where the
  // notice "no agent is assigned yet; work has not started" came from: that
  // string was rendered off `deliveryMirror.verdict`, which only ever
  // reported whether anything had been MERGED, and nothing on that path
  // ever looked at whether an agent was assigned. It read as nonsense on
  // exactly the rows it described -- claimed and in flight, nothing merged
  // yet -- and it is gone rather than reworded.
  return { state: "eligible", reason: "not absorbed by another objective" };
}

export function orderQueueItemsForDispatch(
  items: readonly RegentQueueItemRow[],
): RegentQueueItemRow[] {
  return [...items].sort(
    (left, right) =>
      right.priority - left.priority ||
      left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id),
  );
}
