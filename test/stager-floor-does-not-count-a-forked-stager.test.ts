import assert from "node:assert/strict";
import { test } from "node:test";
import { DESIRED_STATES } from "../src/regent-state/regent-state.service.ts";
import { AGENT_LIFECYCLE_STATES } from "../src/agent-statuses/agent-statuses.types.ts";
import { decideStagerFloorAction } from "../src/alpha-autoscale/stager-floor.ts";

const forkedStager = {
  name: "stager-tenth-prmedia",
  lifecycle: AGENT_LIFECYCLE_STATES.LIVE,
  reportLanded: false,
  role: "Stager",
  focused: false,
};

const conversationalStager = {
  name: "stager-tenth",
  lifecycle: AGENT_LIFECYCLE_STATES.LIVE,
  reportLanded: false,
  role: "Stager",
  focused: false,
};

test("a live forked Stager alone does not satisfy the floor", () => {
  const decision = decideStagerFloorAction(
    DESIRED_STATES.RUNNING,
    [forkedStager],
    new Set(["stager-tenth-prmedia"]),
  );
  assert.deepEqual(decision, { action: "ensure" });
});

test("a live fork beside its parent leaves the parent as the one present Stager", () => {
  const decision = decideStagerFloorAction(
    DESIRED_STATES.RUNNING,
    [conversationalStager, forkedStager],
    new Set(["stager-tenth-prmedia"]),
  );
  assert.deepEqual(decision, { action: "present", name: "stager-tenth" });
});

test("without fork evidence a live Stager still satisfies the floor", () => {
  const decision = decideStagerFloorAction(
    DESIRED_STATES.RUNNING,
    [conversationalStager],
    new Set(),
  );
  assert.deepEqual(decision, { action: "present", name: "stager-tenth" });
});
