// Requirement: a queue whose every row is non-open (complete, dismissed) is
// "nothing to brief", never "ineligible" with no reason. Observed on the live
// Mac on 2026-09-02, the tick after the first `hiregent` row went complete:
// `[alpha-autoscale] auto-brief found ineligible items: ` -- a claim with no
// subject. The Lord: "a log line that says ineligible and then declines to say
// why is a small liar ... go fix it."
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readAutoscaleQueue,
  stageEligibleLaunchBriefs,
} from "./regent-queue-feed.ts";

function storeWithOnlyCompleteRows(briefs: unknown[] = []) {
  const staged: unknown[] = [];
  return {
    staged,
    store: {
      readAll: () => ({
        state: "items",
        items: [
          { objectiveCode: "hiregent", status: "complete", body: "done", launchEligibility: { eligible: true } },
          { objectiveCode: "older", status: "dismissed", body: "no", launchEligibility: null },
        ],
      }),
      readLaunchBriefs: () =>
        briefs.length === 0 ? { state: "positively-empty" } : { state: "briefs", briefs },
      stageLaunchBrief: (brief: unknown) => {
        staged.push(brief);
      },
    } as never,
  };
}

test("auto-brief over a queue with no open rows stages nothing and says so, not 'ineligible' with no reason", () => {
  const { store, staged } = storeWithOnlyCompleteRows();
  const result = stageEligibleLaunchBriefs(store);
  assert.deepEqual(result, { state: "staged", count: 0 });
  assert.equal(staged.length, 0);
});

test("the ready queue over a queue with no open rows is positively empty, even with a lingering brief", () => {
  const { store } = storeWithOnlyCompleteRows([
    {
      objectiveCode: "hiregent",
      canonicalName: "alpha-hiregent-01",
      targetRepo: "/repo",
      targetBranch: "main",
      baseCommit: "abc",
      prBranch: null,
      authorizer: "alpha-autoscale",
      lifecycle: "active",
    },
  ]);
  const result = readAutoscaleQueue(store, { readTokenBalanceVerdict: () => ({ state: "disabled" }) } as never);
  assert.deepEqual(result, { state: "positively-empty" });
});
