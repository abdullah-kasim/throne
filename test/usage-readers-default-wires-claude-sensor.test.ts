// Requirement: a no-arg `UsageReadersService` — what `ThrottleSteeringService`
// builds on every keep-going tick — must carry a real Claude sensor. Observed
// 2026-09-07: it carried a throwing stub, so the Regent's throttle signal read
// "PlanUsageRemainingService is required for Claude usage" on every tick.
// The reader may still fail (no credentials in the suite container), but it
// must fail as the SENSOR fails, never as an unwired stub.

import assert from "node:assert/strict";
import { test } from "node:test";

import { UsageReadersService } from "../src/shared-policy/usage-readers.service.ts";

test("default UsageReadersService reaches the Claude sensor instead of the unwired stub", async () => {
  const payload = await new UsageReadersService().claude();
  if (payload.source === "error") {
    assert.doesNotMatch(payload.error, /PlanUsageRemainingService is required/);
  } else {
    assert.equal(payload.source, "api");
  }
});
