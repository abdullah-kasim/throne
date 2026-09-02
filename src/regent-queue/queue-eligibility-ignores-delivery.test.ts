// Requirement: queue eligibility does not consult the delivery mirror.
//
// Lord's ruling, 2026-08-21: "we dropped the delivery commit -- remove the
// requirement, we don't care about the delivery commit anymore." Before it,
// `classifyEffectiveQueueDecision` read `deliveryMirror.verdict` three ways:
// `delivered` made a row ineligible, `unknown` made it unknown, and
// `not-started` produced the eligible reason "no agent is assigned yet; work
// has not started" -- a claim about STAFFING rendered from a field that only
// ever recorded whether anything had been MERGED. Nothing on that path
// looked at whether an agent was assigned, so the notice read as nonsense on
// exactly the rows it described: claimed, in flight, nothing merged yet.
//
// These pin the removal rather than the wording, so a future reader cannot
// quietly reintroduce a git-derived judgement here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyEffectiveQueueDecision } from "./regent-queue-dispatch.ts";
import type { RegentQueueItemRow } from "./regent-queue.store.ts";

function rowWithMirrorVerdict(verdict: string): RegentQueueItemRow {
  return {
    objectiveCode: "tst",
    status: "in-flight",
    priority: 2,
    agentName: "alpha-tst-thing",
    targetRepo: "/repos/example-target",
    prBranch: null,
    absorption: null,
    deliveryMirror: {
      verdict,
      deliveryCommit: "cafebabe",
      targetRepo: "/repos/example-target",
      targetBranch: "main",
      treeIdentity: null,
      checkedAt: 0,
      reason: null,
    },
  } as unknown as RegentQueueItemRow;
}

test("a row whose delivery mirror says delivered is still eligible", () => {
  const decision = classifyEffectiveQueueDecision(rowWithMirrorVerdict("delivered"));
  assert.equal(decision.state, "eligible");
  assert.equal(decision.reason, "not absorbed by another objective");
});

test("a row whose delivery mirror is unknown is not reported as unknown", () => {
  // The mirror failing to read the repository used to make the whole row's
  // decision `unknown`. Git evidence no longer has a vote, so a failed
  // mirror read cannot make a row undispatchable.
  assert.equal(classifyEffectiveQueueDecision(rowWithMirrorVerdict("unknown")).state, "eligible");
});

test("no queue decision reason claims anything about agent assignment", () => {
  for (const verdict of ["delivered", "unknown", "not-started", "not-delivered"]) {
    const decision = classifyEffectiveQueueDecision(rowWithMirrorVerdict(verdict));
    assert.doesNotMatch(
      decision.reason,
      /agent is assigned|work has not started/,
      `verdict "${verdict}" produced a staffing claim: ${decision.reason}`,
    );
  }
});

test("absorption still makes a row ineligible -- it is the only thing that can", () => {
  const row = rowWithMirrorVerdict("not-delivered");
  const absorbed = {
    ...row,
    absorption: {
      objectiveCode: "oth",
      deliveryCommit: "deadbeef",
      targetRepo: "/repos/example-target",
      targetBranch: "main",
      treeIdentity: null,
      checkedAt: 1,
      reason: null,
    },
  } as unknown as RegentQueueItemRow;

  const decision = classifyEffectiveQueueDecision(absorbed);
  assert.equal(decision.state, "ineligible");
  assert.equal(decision.reason, "absorbed by oth");
});
