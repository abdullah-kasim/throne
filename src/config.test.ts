// Requirement: `omp` pairs are legal `config.user.ts` custom preset
// selections for every claude-native and codex-native model, and the
// disabled deepseek-v4-flash model stays excluded from the omp pool too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HARNESS_NAMES, MODEL_NAMES } from "./harness-routing/harness-identity.ts";
import { MODEL_REGISTRY } from "./harness-routing/model-registry.ts";
import { CONFIGURED_MODEL_PAIRS } from "./config.ts";

test("CONFIGURED_MODEL_PAIRS makes every claude-native and codex-native model a legal omp selection", () => {
  // Selected as "every enabled entry that is not opencode-primary" rather than
  // by a `claude`/`codex` primary harness: since 2026-08-27 the four Anthropic
  // models carry an `omp` PRIMARY (see
  // harness-routing/claude-native-models-default-to-omp.test.ts). Selecting by
  // primary harness silently shrank this population from 10 to 6 and stopped
  // checking the very models the requirement names.
  const claudeOrCodexPrimaryEnabled = MODEL_REGISTRY.filter(
    (candidate) =>
      candidate.enabled && candidate.harness !== HARNESS_NAMES.OPENCODE,
  );
  assert.equal(claudeOrCodexPrimaryEnabled.length, 10);

  for (const entry of claudeOrCodexPrimaryEnabled) {
    assert.ok(
      CONFIGURED_MODEL_PAIRS.some(
        (pair) => pair.harness === HARNESS_NAMES.OMP && pair.model === entry.model,
      ),
      `expected {harness:'omp', model:'${entry.model}'} in CONFIGURED_MODEL_PAIRS`,
    );
  }

  assert.ok(
    !CONFIGURED_MODEL_PAIRS.some(
      (pair) =>
        pair.harness === HARNESS_NAMES.OMP &&
        pair.model === MODEL_NAMES.DEEPSEEK_V4_FLASH,
    ),
    "deepseek-v4-flash must stay excluded from omp pairs",
  );
});
