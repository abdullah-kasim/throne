import assert from "node:assert/strict";
import { test } from "node:test";
import { entryAvailableUnderHarness } from "./registry-derivation.ts";
import {
  HARNESS_NAMES,
  MODEL_NAMES,
  type RuntimeHarness,
} from "./harness-identity.ts";
import { MODEL_REGISTRY } from "./model-registry.ts";

const RUNTIME_HARNESSES_UNDER_TEST: readonly RuntimeHarness[] = [
  HARNESS_NAMES.CLAUDE,
  HARNESS_NAMES.CODEX,
  HARNESS_NAMES.OPENCODE,
];

test("a disabled model stays excluded from every harness", () => {
  const deepseek = MODEL_REGISTRY.find(
    (candidate) => candidate.model === MODEL_NAMES.DEEPSEEK_V4_FLASH,
  );
  assert.ok(deepseek, "expected the deepseek-v4-flash registry entry to exist");
  assert.equal(deepseek.enabled, false);

  for (const harness of RUNTIME_HARNESSES_UNDER_TEST) {
    assert.equal(
      entryAvailableUnderHarness(deepseek, harness),
      false,
      `expected deepseek-v4-flash to stay excluded from ${harness}`,
    );
  }
});
