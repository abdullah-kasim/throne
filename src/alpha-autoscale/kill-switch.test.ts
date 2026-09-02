// Requirement: the autoscaler is permanently armed (the Lord, 2026-09-02), so
// the env switch reads ON unless explicitly "0" -- a manual `autoscale-now`
// from a shell that never saw the service template's Environment= must pass
// the same gate the cron tick passes. Observed during the Lord's demo: the
// shell run stopped at "skip: kill switch off" while the backend spawned.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTOSCALE_KILL_SWITCH_ENV_VAR, isAutoscaleKillSwitchOn } from "./kill-switch.ts";

test("absent, empty, and 1 all read as armed", () => {
  assert.equal(isAutoscaleKillSwitchOn({}), true);
  assert.equal(isAutoscaleKillSwitchOn({ [AUTOSCALE_KILL_SWITCH_ENV_VAR]: "" }), true);
  assert.equal(isAutoscaleKillSwitchOn({ [AUTOSCALE_KILL_SWITCH_ENV_VAR]: "1" }), true);
});

test("only an explicit 0 disarms", () => {
  assert.equal(isAutoscaleKillSwitchOn({ [AUTOSCALE_KILL_SWITCH_ENV_VAR]: "0" }), false);
});
