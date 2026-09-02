// Requirement: update-queue must enforce the same dispatchability guarantee
// add-to-queue enforces, so a queue item cannot be edited back into an
// undispatchable state. This is an integration test in the sense the court
// requires: it drives the real `updateQueueItem`/`parseUpdateQueueArgs`
// against a real temp-directory SQLite store and asks the REAL
// `classifyEffectiveQueueDecision`/`deriveQueueDeliveryMirror` whether the
// result is dispatchable — nothing here restates what the writer wrote.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  parseUpdateQueueArgs,
  planLaunchMetadataConsistency,
  updateQueueItem,
} from "../src/update-queue/update-queue-runtime.ts";
import {
  openRegentQueueStore,
  type RegentQueueMutationStore,
} from "../src/regent-queue/regent-queue.store.ts";
import { RegentQueueItemStatus } from "../src/regent-queue/regent-queue-item-state.ts";
import { classifyEffectiveQueueDecision } from "../src/regent-queue/regent-queue-dispatch.ts";
import { deriveQueueDeliveryMirror } from "../src/reconcile-queue/reconcile-queue-runtime.ts";

const PLACEHOLDER_REPO = "/repo/throne";
const FIXED_TIME = 1_700_000_000_000;

const scratchDirectories: string[] = [];
let store: RegentQueueMutationStore;
let nextId = 0;

before(() => {
  const directory = mkdtempSync(join(tmpdir(), "throne-update-queue-"));
  scratchDirectories.push(directory);
  store = openRegentQueueStore(
    join(directory, "regent-queue.sqlite3"),
    () => FIXED_TIME,
  );
});

after(() => {
  store.close();
  for (const directory of scratchDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Inserts a fresh open item with an agent already assigned and work
 *  in flight (no delivery commit yet), then leaves its mirror however the
 *  test wants to start from. Each test gets its own objective code so the
 *  shared store never cross-contaminates cases. */
function insertInFlightItem(overrides: {
  objectiveCode: string;
  mirrorVerdict?: "unknown" | "not-started" | "delivered";
}): void {
  nextId += 1;
  store.insertItem({
    objectiveCode: overrides.objectiveCode,
    body: `fixture item ${nextId}`,
    launch: {
      alphaName: `alpha-${overrides.objectiveCode}-fixture`,
      targetRepo: PLACEHOLDER_REPO,
      targetBranch: "main",
      baseCommit: "0".repeat(40),
    },
    deliveryMirror: {
      verdict: overrides.mirrorVerdict ?? "unknown",
      deliveryCommit: null,
      targetRepo: PLACEHOLDER_REPO,
      targetBranch: "main",
      treeIdentity: null,
      checkedAt: FIXED_TIME,
      reason: "fixture: mirror seeded directly, not derived",
    },
  });
  store.mutateItem(overrides.objectiveCode, {
    agentName: `alpha-${overrides.objectiveCode}-fixture`,
    targetRepo: PLACEHOLDER_REPO,
    baseCommit: "0".repeat(40),
  });
}

test("clearing an in-flight item's agent name without update-queue's guard would let the next reconcile pass falsely call it eligible", async () => {
  // Reproduces the pre-fix hazard directly against the REAL
  // deriveQueueDeliveryMirror: an agent name cleared by hand (bypassing the
  // guard this slice adds), with the mirror left at "unknown" exactly as
  // update-queue used to leave it, reads back as a false "not-started".
  insertInFlightItem({ objectiveCode: "uqvrepro", mirrorVerdict: "unknown" });
  const bypassed = store.mutateItem("uqvrepro", { agentName: null });
  assert.equal(bypassed.deliveryMirror.verdict, "unknown");

  const rederived = await deriveQueueDeliveryMirror(bypassed, {
    repoRoot: async (repo) => repo,
    now: () => FIXED_TIME,
  });
  assert.equal(
    rederived.verdict,
    "not-started",
    "the real deriveQueueDeliveryMirror reports a released item as not-started/eligible, " +
      "proving the side door: a stale 'unknown' mirror on an agent-cleared item is not safe to leave lying around",
  );
});

test("we should be able to release a queue item from a dead agent and have it end the update dispatchable", () => {
  insertInFlightItem({ objectiveCode: "uqvrelease", mirrorVerdict: "unknown" });
  const input = parseUpdateQueueArgs([
    "--objective-code",
    "uqvrelease",
    "--clear-agent-name",
  ]);
  const result = updateQueueItem(store, input, () => FIXED_TIME);

  assert.equal(result.agentName, null);
  assert.equal(result.deliveryMirror.verdict, "not-started");
  assert.equal(
    classifyEffectiveQueueDecision(result).state,
    "eligible",
    "the real dispatch classifier must call the released item eligible",
  );
});

test("we should refuse clearing a still-assigned item's target repo, naming the objective and the missing field", () => {
  insertInFlightItem({ objectiveCode: "uqvreponly" });
  const beforeMutation = store.readItem("uqvreponly");
  const input = parseUpdateQueueArgs([
    "--objective-code",
    "uqvreponly",
    "--clear-target-repo",
  ]);

  assert.throws(
    () => updateQueueItem(store, input, () => FIXED_TIME),
    /uqvreponly.*alpha-uqvreponly-fixture.*target repository/s,
  );
  const afterMutation = store.readItem("uqvreponly");
  assert.deepEqual(
    afterMutation,
    beforeMutation,
    "a refused mutation must not touch the store",
  );
});

test("we should refuse clearing a still-assigned item's base commit, naming the objective and the missing field", () => {
  insertInFlightItem({ objectiveCode: "uqvcommitonly" });
  const beforeMutation = store.readItem("uqvcommitonly");
  const input = parseUpdateQueueArgs([
    "--objective-code",
    "uqvcommitonly",
    "--clear-base-commit",
  ]);

  assert.throws(
    () => updateQueueItem(store, input, () => FIXED_TIME),
    /uqvcommitonly.*alpha-uqvcommitonly-fixture.*base commit/s,
  );
  const afterMutation = store.readItem("uqvcommitonly");
  assert.deepEqual(
    afterMutation,
    beforeMutation,
    "a refused mutation must not touch the store",
  );
});

test("we should be able to fully release a dead agent's item by clearing agent name, target repo, and base commit together", () => {
  insertInFlightItem({ objectiveCode: "uqvfullrelease" });
  const input = parseUpdateQueueArgs([
    "--objective-code",
    "uqvfullrelease",
    "--clear-agent-name",
    "--clear-target-repo",
    "--clear-base-commit",
  ]);
  const result = updateQueueItem(store, input, () => FIXED_TIME);

  assert.equal(result.agentName, null);
  assert.equal(result.targetRepo, null);
  assert.equal(result.baseCommit, null);
  assert.equal(result.deliveryMirror.verdict, "not-started");
});

test("a delivered item must never be resurrected as dispatchable just because its agent name was cleared", () => {
  insertInFlightItem({ objectiveCode: "uqvdelivered", mirrorVerdict: "delivered" });
  const input = parseUpdateQueueArgs([
    "--objective-code",
    "uqvdelivered",
    "--clear-agent-name",
  ]);
  const result = updateQueueItem(store, input, () => FIXED_TIME);

  assert.equal(result.agentName, null);
  assert.equal(
    result.deliveryMirror.verdict,
    "delivered",
    "a delivered mirror is never overwritten by a release",
  );
});

test("editing an item's body must leave its delivery mirror untouched", () => {
  insertInFlightItem({ objectiveCode: "uqvbodyedit", mirrorVerdict: "unknown" });
  const beforeMutation = store.readItem("uqvbodyedit");
  const input = parseUpdateQueueArgs([
    "--objective-code",
    "uqvbodyedit",
    "--body",
    "revised body text",
  ]);
  const result = updateQueueItem(store, input, () => FIXED_TIME);

  assert.equal(result.body, "revised body text");
  assert.deepEqual(result.deliveryMirror, beforeMutation!.deliveryMirror);
});

test("we should refuse an --agent-name value Herdr could never spawn because it is over the length ceiling", () => {
  const overLong = "a".repeat(33);
  assert.throws(
    () =>
      parseUpdateQueueArgs([
        "--objective-code",
        "uqvoverlong",
        "--agent-name",
        overLong,
      ]),
    /33 characters; Herdr allows at most 32/,
  );
});

test("we should refuse an --agent-name value Herdr could never spawn because it is whitespace-padded", () => {
  assert.throws(
    () =>
      parseUpdateQueueArgs([
        "--objective-code",
        "uqvwhitespace",
        "--agent-name",
        " padded-name ",
      ]),
    /lowercase ASCII alphanumeric words/,
  );
});

test("a mutation that never touches agent name, target repo, or base commit is a no-op for the consistency guard", () => {
  const openItem = {
    id: "noop-fixture",
    objectiveCode: "uqvnoop",
    status: RegentQueueItemStatus.Open,
    body: "unchanged",
    prBranch: null,
    agentName: "alpha-uqvnoop-fixture",
    targetRepo: PLACEHOLDER_REPO,
    baseCommit: "0".repeat(40),
    deliveryCommit: null,
    deliveryMirror: {
      verdict: "unknown" as const,
      deliveryCommit: null,
      targetRepo: PLACEHOLDER_REPO,
      targetBranch: "main",
      treeIdentity: null,
      checkedAt: FIXED_TIME,
      reason: null,
    },
    absorption: null,
    priority: 0,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };

  const plan = planLaunchMetadataConsistency(
    openItem,
    { priority: 5 },
    "uqvnoop",
    () => FIXED_TIME,
  );
  assert.equal(plan, undefined);
});
