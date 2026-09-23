import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_NAMES, resolveModel } from "../src/harness-routing/harness.ts";

test("the live Opus 5.5 model ids resolve to the opus registry row", () => {
  assert.equal(resolveModel("claude", "claude-opus-5-5"), MODEL_NAMES.OPUS);
  assert.equal(resolveModel("claude", "opus-5.5"), MODEL_NAMES.OPUS);
  assert.equal(resolveModel("claude", "opus-5-5"), MODEL_NAMES.OPUS);
});
