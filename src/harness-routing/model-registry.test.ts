// Requirement: every currently-enabled claude-native and codex-native model
// is available under the `omp` runtime harness, while a disabled entry
// (opencode-go/deepseek-v4-flash) stays excluded everywhere, including omp.
// Exercised over the real MODEL_REGISTRY, not a fixture.
//
// The population is selected as "every enabled entry that is not
// opencode-primary" rather than by a `claude`/`codex` primary harness, because
// since 2026-08-27 the four Anthropic models carry an `omp` PRIMARY (they
// infer omp by default; see claude-native-models-default-to-omp.test.ts).
// Selecting by primary harness silently shrank this test's population from 10
// to 6 and stopped checking the very models the requirement names.
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
  HARNESS_NAMES.OMP,
];

test("every claude-native and codex-native model can be selected under the omp harness", () => {
  const claudeOrCodexEnabled = MODEL_REGISTRY.filter(
    (candidate) =>
      candidate.enabled && candidate.harness !== HARNESS_NAMES.OPENCODE,
  );
  assert.equal(claudeOrCodexEnabled.length, 10);

  for (const entry of claudeOrCodexEnabled) {
    assert.ok(
      entryAvailableUnderHarness(entry, HARNESS_NAMES.OMP),
      `expected "${entry.model}" to be available under omp`,
    );
  }
});

test("a disabled model stays excluded from every harness, including omp", () => {
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
