// The `deferred` status shipped with a self-defeating bug: it was left out of
// LIVE_QUEUE_ITEM_STATUSES, so four held objectives rendered as "No items —
// the queue is confirmed empty." The Lord asked what was in the queue and got
// that answer, from the feature built so held work could be seen.
//
// Held work invisible behind a status filter is the same defect as held work
// invisible behind a misused status.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_QUEUE_ITEM_STATUSES,
  renderRegentQueueAsMarkdown,
} from "../src/regent-queue/regent-queue-render.ts";
import { RegentQueueItemStatus } from "../src/regent-queue/regent-queue-item-state.ts";
import type { RegentQueueItemRow } from "../src/regent-queue/regent-queue-row.ts";

function row(
  objectiveCode: string,
  status: RegentQueueItemStatus,
  extra: Partial<RegentQueueItemRow> = {},
): RegentQueueItemRow {
  return {
    id: objectiveCode,
    objectiveCode,
    status,
    body: `body of ${objectiveCode}`,
    prBranch: null,
    agentName: null,
    targetRepo: null,
    baseCommit: null,
    deliveryCommit: null,
    deliveryMirror: {
      verdict: "unknown",
      deliveryCommit: null,
      targetRepo: null,
      targetBranch: null,
      treeIdentity: null,
      checkedAt: null,
      reason: null,
    },
    absorption: null,
    deferral: null,
    priority: 0,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  } as RegentQueueItemRow;
}

test("deferred is a LIVE status — held work is waiting, not finished", () => {
  assert.ok(
    LIVE_QUEUE_ITEM_STATUSES.includes(RegentQueueItemStatus.Deferred),
    "a deferred row is filed and authorised; the only thing it is not is launchable yet",
  );
});

test("a queue of nothing but held rows does NOT render as empty", () => {
  // The exact live shape at the time the bug was found: four office rows held
  // on the Lord's ruling, everything else terminal.
  const items = [
    row("olgp", RegentQueueItemStatus.Deferred, {
      deferral: { dependsOn: [], releaseAuthority: "Lord", reason: null },
    }),
    row("olsv", RegentQueueItemStatus.Deferred, {
      deferral: { dependsOn: ["olgp"], releaseAuthority: null, reason: null },
    }),
    row("done", RegentQueueItemStatus.Complete),
  ];
  const markdown = renderRegentQueueAsMarkdown(
    { state: "items", items },
    { statuses: LIVE_QUEUE_ITEM_STATUSES },
  );
  assert.doesNotMatch(
    markdown,
    /confirmed empty/,
    `held work rendered as an empty queue:\n${markdown}`,
  );
  assert.match(markdown, /olgp/);
  assert.match(markdown, /olsv/);
  assert.doesNotMatch(markdown, /done/, "terminal rows still stay out");
});

test("a genuinely empty queue still reports empty", () => {
  const markdown = renderRegentQueueAsMarkdown(
    { state: "positively-empty" },
    { statuses: LIVE_QUEUE_ITEM_STATUSES },
  );
  assert.match(markdown, /empty/);
});

test("a held row is visually distinct from one in flight", () => {
  // Telling a hold from real work at a glance is the whole point; borrowing
  // in-flight's marker would reproduce the confusion in the renderer.
  const markdown = renderRegentQueueAsMarkdown(
    {
      state: "items",
      items: [
        row("held", RegentQueueItemStatus.Deferred, {
          deferral: { dependsOn: ["x"], releaseAuthority: null, reason: null },
        }),
        row("flying", RegentQueueItemStatus.InFlight, {
          agentName: "alpha-flying",
        }),
      ],
    },
    { statuses: LIVE_QUEUE_ITEM_STATUSES },
  );
  const heldLine = markdown.split("\n").find((l) => l.includes("held")) ?? "";
  const flyingLine = markdown.split("\n").find((l) => l.includes("flying")) ?? "";
  assert.notEqual(
    heldLine.trim().slice(0, 4),
    flyingLine.trim().slice(0, 4),
    "held and in-flight rows must not share a status marker",
  );
});
