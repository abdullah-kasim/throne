import test from "node:test";
import assert from "node:assert/strict";
import { THROTTLE_BANDS } from "../src/shared-policy/usagethrottle.ts";
import {
  ALPHA_AUTOSCALE_BOUNDS,
  ALPHA_LIVE_FLOOR_MINIMUM,
} from "../src/alpha-autoscale/alpha-autoscale-bounds.ts";

test("the caution advisory paces the Regent to the same Alpha count the autoscaler keeps as its floor", () => {
  const caution = THROTTLE_BANDS.find((band) => band.name === "CAUTION");
  assert.equal(ALPHA_AUTOSCALE_BOUNDS.floor, ALPHA_LIVE_FLOOR_MINIMUM);
  assert.equal(
    caution?.advisory,
    `pace to ≤${ALPHA_AUTOSCALE_BOUNDS.floor} concurrent Alphas`,
  );
  assert.equal(caution?.advisory, "pace to ≤5 concurrent Alphas");
});
