import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_NAMES, resolveModel } from "../src/harness-routing/harness.ts";

test("the live Fable 5.1 model ids resolve to the fable registry row", () => {
  assert.equal(resolveModel("claude", "claude-fable-5-1"), MODEL_NAMES.FABLE);
  assert.equal(resolveModel("claude", "fable-5.1"), MODEL_NAMES.FABLE);
  assert.equal(resolveModel("claude", "claude-opus-5"), MODEL_NAMES.OPUS);
});
