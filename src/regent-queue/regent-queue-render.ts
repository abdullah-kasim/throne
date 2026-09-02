import type {
  RegentQueueItemRow,
  RegentQueueReadResult,
} from "./regent-queue.store.ts";
import { RegentQueueItemStatus } from "./regent-queue-item-state.ts";
import {
  classifyEffectiveQueueDecision,
  isActiveQueueAbsorption,
  orderQueueItemsForDispatch,
} from "./regent-queue-dispatch.ts";

/** One status marker per queue-item status, familiar to a reader of the old `QUEUE.md`
 *  bullets (⚪ open, 🔵 in-flight, ✅ complete, ⚫ abandoned) without needing to reproduce
 *  that file's exact historical formatting. `deferred` gets its own marker
 *  rather than borrowing in-flight's: the entire point of the status is that a
 *  reader can tell a held row from a flying one at a glance, which is exactly
 *  what an agentless in-flight row made impossible. */
const STATUS_MARKERS: Record<RegentQueueItemStatus, string> = {
  [RegentQueueItemStatus.Open]: "⚪",
  [RegentQueueItemStatus.Deferred]: "⏸️",
  [RegentQueueItemStatus.InFlight]: "🔵",
  [RegentQueueItemStatus.Complete]: "✅",
  [RegentQueueItemStatus.Abandoned]: "⚫",
};

/**
 * The one shared definition of "live" a queue item: still next-up or actively
 * being worked or waiting to be, as opposed to landed (`complete`) or given
 * up on (`abandoned`). Every consumer that only wants live items (the Regent's
 * 30-minute nudge, `notify-lord`'s completion digest, `throne-startup`'s boot
 * digest) passes this same constant to `renderRegentQueueAsMarkdown` rather
 * than each re-deriving its own status list.
 */
export const LIVE_QUEUE_ITEM_STATUSES: readonly RegentQueueItemStatus[] = [
  RegentQueueItemStatus.Open,
  // A deferred row is LIVE WORK. It is filed, authorised, and waiting — the
  // only thing it is not is launchable yet.
  //
  // Omitting it here was the first bug the `deferred` status shipped with, and
  // it was a self-defeating one: the status exists so held work can be SEEN,
  // and leaving it out of the live view meant four held objectives rendered as
  // "No items — the queue is confirmed empty." The Lord asked what was in the
  // queue and the answer was a lie, from the feature built to stop exactly
  // that. Held work that nobody can see is the thing being fixed, whether it
  // is hidden behind a misused status or behind a status filter.
  //
  // This constant is deliberately shared by every live-items consumer — the
  // Regent's 30-minute nudge, notify-lord's digest, throne-startup's boot
  // digest, and render-queue's default view — so all four were blind at once
  // and all four are fixed at once.
  RegentQueueItemStatus.Deferred,
  RegentQueueItemStatus.InFlight,
];

/**
 * Optional narrowing applied to a store read before rendering.
 * `statuses`, when given, keeps only items whose status is in the set —
 * pass `LIVE_QUEUE_ITEM_STATUSES` for the live-items-only view.
 * `excludeObjectiveCode`, when given, additionally drops the in-flight item
 * whose `objectiveCode` case-insensitively matches (so a completing campaign
 * can omit its own still-in-flight entry from its own completion push); an
 * item with no `objectiveCode` recorded is never dropped by this rule
 * (fail open).
 */
export interface RegentQueueRenderFilter {
  readonly statuses?: readonly RegentQueueItemStatus[];
  readonly excludeObjectiveCode?: string;
}

function itemSurvivesFilter(
  item: RegentQueueItemRow,
  filter: RegentQueueRenderFilter,
): boolean {
  if (filter.statuses !== undefined && !filter.statuses.includes(item.status)) {
    return false;
  }
  if (
    filter.excludeObjectiveCode !== undefined &&
    item.status === RegentQueueItemStatus.InFlight
  ) {
    return (
      item.objectiveCode?.toLowerCase() !==
      filter.excludeObjectiveCode.toLowerCase()
    );
  }
  return true;
}

function renderItem(item: RegentQueueItemRow): string {
  const marker = STATUS_MARKERS[item.status];
  const label = item.objectiveCode ?? item.id;
  const lifecycleBits = [
    item.prBranch ? `pr: ${item.prBranch}` : undefined,
    item.agentName ? `agent: ${item.agentName}` : undefined,
    item.targetRepo ? `repo: ${item.targetRepo}` : undefined,
    item.baseCommit ? `base: ${item.baseCommit}` : undefined,
    item.deliveryCommit ? `delivered: ${item.deliveryCommit}` : undefined,
  ].filter((bit): bit is string => bit !== undefined);
  const lifecycleSuffix =
    lifecycleBits.length > 0 ? ` _(${lifecycleBits.join(", ")})_` : "";
  const eligibility =
    item.launchEligibility === undefined || item.launchEligibility.eligible
      ? ""
      : ` _(${item.launchEligibility.reason})_`;
  const decision = classifyEffectiveQueueDecision(item);
  const decisionLabel =
    decision.state === "ineligible"
      ? decision.annotation
      : decision.state.toUpperCase();
  const decisionSuffix = ` _(priority: ${item.priority}, decision: ${decisionLabel}, reason: ${decision.reason})_`;
  // Absorbed rows still show the absorber's evidence. Everything else now
  // shows the row's OWN recorded coordinates rather than the delivery
  // mirror's copy of them: the mirror no longer decides anything (see
  // `classifyEffectiveQueueDecision`), so rendering it here would print
  // git-derived evidence for a judgement nothing makes any more.
  const evidence =
    decision.state === "ineligible" &&
    decision.annotation === "ABSORBED-PENDING" &&
    isActiveQueueAbsorption(item.absorption)
      ? item.absorption!
      : {
          deliveryCommit: null,
          targetRepo: item.targetRepo,
          targetBranch: item.prBranch,
          treeIdentity: null,
        };
  const evidenceBits = [
    evidence.deliveryCommit ? `commit: ${evidence.deliveryCommit}` : undefined,
    evidence.targetRepo ? `repository: ${evidence.targetRepo}` : undefined,
    evidence.targetBranch ? `branch: ${evidence.targetBranch}` : undefined,
    evidence.treeIdentity ? `tree: ${evidence.treeIdentity}` : undefined,
  ].filter((bit): bit is string => bit !== undefined);
  const evidenceSuffix =
    evidenceBits.length === 0 ? "" : ` _(${evidenceBits.join(", ")})_`;
  return `- ${marker} **${label}** (${item.status})${lifecycleSuffix}${eligibility}${decisionSuffix}${evidenceSuffix}\n\n  ${item.body}`;
}

/**
 * Pure read-and-format path over the store's tri-state read result — the render itself
 * never touches the store or the filesystem. Produces a markdown view shaped enough like
 * the legacy `QUEUE.md` bullets (status marker, objective code / id, prose body) to be
 * familiar, without reproducing that file's exact historical formatting. The `unknown`
 * state renders as a loud, explicit warning — it is never allowed to read as "empty".
 */
export function renderRegentQueueAsMarkdown(
  result: RegentQueueReadResult,
  filter: RegentQueueRenderFilter = {},
): string {
  if (result.state === "unknown") {
    return (
      `# Regent queue — ⚠️ COULD NOT READ\n\n` +
      `The queue store could not be read; this is NOT the same as an empty queue.\n\n` +
      `Reason: ${result.reason}\n`
    );
  }
  if (result.state === "positively-empty") {
    return `# Regent queue\n\nNo items — the queue is confirmed empty.\n`;
  }
  const items = orderQueueItemsForDispatch(
    result.items.filter((item) => itemSurvivesFilter(item, filter)),
  );
  if (items.length === 0) {
    return `# Regent queue\n\nNo items — the queue is confirmed empty.\n`;
  }
  const rendered = items.map(renderItem).join("\n\n");
  return `# Regent queue (${items.length} item(s))\n\n${rendered}\n`;
}
