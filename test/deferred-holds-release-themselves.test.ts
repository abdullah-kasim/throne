// The Lord's order, 2026-08-25, after five objectives sat "in-flight" with no
// agent flying any of them and the court ran idle: the autoscaler must detect
// held work and launch it. `deferred` makes a hold expressible; these tests
// pin what releases one and — more importantly — what must not.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  idleRecoveryCandidates,
  isAgentlessInFlight,
  releasableDeferrals,
} from "../src/alpha-autoscale/deferral-release.ts";
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
    body: "",
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

function held(
  code: string,
  dependsOn: string[],
  opts: { authority?: string; priority?: number } = {},
): RegentQueueItemRow {
  return row(code, RegentQueueItemStatus.Deferred, {
    priority: opts.priority ?? 0,
    deferral: {
      dependsOn,
      releaseAuthority: opts.authority ?? null,
      reason: null,
    },
  });
}

test("a hold releases once every objective it waited on is terminal", () => {
  // gbpg's real shape: it waited on the other gabledge rows, they all
  // finished, and nothing noticed for hours.
  const released = releasableDeferrals([
    row("gbau", RegentQueueItemStatus.Complete),
    row("gbms", RegentQueueItemStatus.Complete),
    held("gbpg", ["gbau", "gbms"]),
  ]);
  assert.deepEqual(
    released.map((r) => r.objectiveCode),
    ["gbpg"],
  );
  assert.match(released[0]!.reason, /every objective it waited on is terminal/);
});

test("a hold with even one unfinished dependency stays shut", () => {
  const released = releasableDeferrals([
    row("gbau", RegentQueueItemStatus.Complete),
    row("gbms", RegentQueueItemStatus.InFlight),
    held("gbpg", ["gbau", "gbms"]),
  ]);
  assert.deepEqual(released, []);
});

test("an abandoned dependency counts as terminal — the wait is genuinely over", () => {
  const released = releasableDeferrals([
    row("dead", RegentQueueItemStatus.Abandoned),
    held("next", ["dead"]),
  ]);
  assert.deepEqual(
    released.map((r) => r.objectiveCode),
    ["next"],
  );
});

test("an UNKNOWN dependency code never releases — a typo must fail closed", () => {
  // The opposite default would turn a misspelling into an immediate launch.
  const released = releasableDeferrals([held("next", ["gbua"])]);
  assert.deepEqual(released, []);
});

test("a hold waiting on a PERSON is never auto-released", () => {
  // olgp's real shape: "the Lord must rule on D6". No predicate can evaluate
  // that, and every dependency it lists being finished must not stand in for
  // the ruling.
  const released = releasableDeferrals([
    row("olcm", RegentQueueItemStatus.Complete),
    held("olgp", ["olcm"], { authority: "Lord" }),
  ]);
  assert.deepEqual(released, []);
});

test("releases come back highest priority first", () => {
  const released = releasableDeferrals([
    row("done", RegentQueueItemStatus.Complete),
    held("low", ["done"], { priority: 10 }),
    held("high", ["done"], { priority: 90 }),
  ]);
  assert.deepEqual(
    released.map((r) => r.objectiveCode),
    ["high", "low"],
  );
});

test("recovery picks up held rows AND agentless in-flight rows", () => {
  // Agentless in-flight is the pre-`deferred` spelling of a hold and still
  // exists on rows filed before this feature.
  const { launchable } = idleRecoveryCandidates([
    row("flying", RegentQueueItemStatus.InFlight, { agentName: "alpha-x" }),
    row("legacy", RegentQueueItemStatus.InFlight, { priority: 5 }),
    held("waiting", ["never"], { priority: 50 }),
  ]);
  assert.deepEqual(
    launchable.map((r) => r.objectiveCode),
    ["waiting", "legacy"],
  );
});

test("recovery DOES launch a row waiting on a named authority, and records whose", () => {
  // CONTRACT REVERSAL, the Lord's order of 2026-08-25: "autoscale MUST
  // dispatch deferred tasks once it ran out of available tasks", then
  // "autoscale has my authority to do so".
  //
  // This test previously asserted the opposite. The exemption looked
  // principled and was not: olgp sat held "awaiting the Lord's ruling on D6"
  // when the spike meant to verify D6 had failed on a malformed FreeRDP
  // argument and a guest with no SSH — unfinished agent work dressed as a
  // decision. The exemption then guaranteed four objectives would never move
  // while the court ran idle.
  //
  // It is asserted as the NEW contract rather than by deleting the old
  // constraint: recovery must launch it AND must name the authority, because
  // a delegated decision nobody can see is indistinguishable from a lost one.
  const { launchable, overriddenAuthority } = idleRecoveryCandidates([
    held("olgp", ["olcm"], { authority: "Lord", priority: 99 }),
    held("free", ["never"], { priority: 1 }),
  ]);
  assert.deepEqual(
    launchable.map((r) => r.objectiveCode),
    ["olgp", "free"],
    "an exhausted queue outranks a hold waiting on a person",
  );
  assert.deepEqual(overriddenAuthority, [
    { objectiveCode: "olgp", authority: "Lord" },
  ]);
});

test("the AUTOMATIC release pass still never lifts an authority hold", () => {
  // Recovery is the last resort; routine release is not. Dependencies
  // finishing genuinely does not stand in for a person's ruling, so the two
  // paths must not be collapsed into one.
  const released = releasableDeferrals([
    row("olcm", RegentQueueItemStatus.Complete),
    held("olgp", ["olcm"], { authority: "Lord" }),
  ]);
  assert.deepEqual(released, [], "only exhaustion may override an authority");
});

test("recovery leaves a genuinely claimed row alone", () => {
  const { launchable } = idleRecoveryCandidates([
    row("busy", RegentQueueItemStatus.InFlight, { agentName: "alpha-busy" }),
    row("done", RegentQueueItemStatus.Complete),
    row("open", RegentQueueItemStatus.Open),
  ]);
  assert.deepEqual(launchable, []);
});

test("isAgentlessInFlight distinguishes a hold from real work in progress", () => {
  assert.equal(
    isAgentlessInFlight(row("a", RegentQueueItemStatus.InFlight)),
    true,
  );
  assert.equal(
    isAgentlessInFlight(
      row("b", RegentQueueItemStatus.InFlight, { agentName: "alpha-b" }),
    ),
    false,
  );
  assert.equal(isAgentlessInFlight(row("c", RegentQueueItemStatus.Open)), false);
});

// --- CLI surface: a hold must be expressible, and must carry its reason ---

import { parseUpdateQueueArgs } from "../src/update-queue/update-queue-runtime.ts";

test("--status deferred with --depends-on records the machine-checkable hold", () => {
  const input = parseUpdateQueueArgs([
    "--objective-code",
    "gbpg",
    "--status",
    "deferred",
    "--depends-on",
    "gbau, gbms ,gbwr",
  ]);
  assert.deepEqual(input.mutation.deferral, {
    dependsOn: ["gbau", "gbms", "gbwr"],
    releaseAuthority: null,
    reason: null,
  });
});

test("--release-authority records the hold no predicate can lift", () => {
  const input = parseUpdateQueueArgs([
    "--objective-code",
    "olgp",
    "--status",
    "deferred",
    "--release-authority",
    "Lord",
    "--defer-reason",
    "D6 unverified; S3 returned UNRESOLVED / FAIL",
  ]);
  assert.equal(input.mutation.deferral?.releaseAuthority, "Lord");
  assert.match(input.mutation.deferral?.reason ?? "", /S3 returned UNRESOLVED/);
});

test("deferring with NO condition is refused — that is the old invisible hold", () => {
  assert.throws(
    () => parseUpdateQueueArgs(["--objective-code", "x", "--status", "deferred"]),
    /requires --depends-on .* or --release-authority/s,
  );
});

test("deferral flags without --status deferred are refused, not inferred", () => {
  assert.throws(
    () =>
      parseUpdateQueueArgs([
        "--objective-code",
        "x",
        "--depends-on",
        "y",
      ]),
    /require --status deferred/,
  );
});

test("releasing a row by hand clears its hold rather than leaving a ghost", () => {
  const input = parseUpdateQueueArgs([
    "--objective-code",
    "olgp",
    "--status",
    "open",
  ]);
  assert.equal(input.mutation.status, "open");
  // The store nulls the deferral columns whenever status leaves `deferred`,
  // so no stale dependency list can be read back as a live hold.
  assert.equal(input.mutation.deferral, undefined);
});
