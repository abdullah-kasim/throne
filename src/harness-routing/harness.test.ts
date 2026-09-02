// Requirements this file proves:
// 1. An unrecognized harness fails loudly instead of silently launching as
//    Claude — `launcherFamily()`'s exhaustive-dispatch fix (00_overview.md,
//    03_wire_omp_launch_and_fix_fallthrough.md).
// 2. Every claude-native and codex-native model can be launched under the
//    omp harness, at every effort level its own registered range admits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HARNESS_NAMES, type Harness } from "./harness-identity.ts";
import { MODEL_REGISTRY } from "./model-registry.ts";
import { buildLaunchArgv, launcherFamily } from "./harness.ts";

test("an unrecognized harness fails loudly instead of silently launching as Claude", () => {
  const bogusHarness = "not-a-real-harness" as Harness;
  assert.throws(
    () => launcherFamily(bogusHarness, "opus"),
    (error: unknown) =>
      error instanceof Error && error.message.includes(bogusHarness),
    "expected launcherFamily to throw naming the unrecognized harness, not resolve it to claudey/claudey-all",
  );
});

// Selected as "every enabled entry that is not opencode-primary" rather than by
// a `claude`/`codex` primary harness: since 2026-08-27 the four Anthropic
// models carry an `omp` PRIMARY so they infer omp by default (see
// claude-native-models-default-to-omp.test.ts). Selecting by primary harness
// silently shrank this population from 10 to 6 and stopped exercising the very
// models requirement 2 names.
const CLAUDE_OR_CODEX_PRIMARY_ENABLED = MODEL_REGISTRY.filter(
  (candidate) =>
    candidate.enabled && candidate.harness !== HARNESS_NAMES.OPENCODE,
);

test("every claude-native and codex-native model can be launched under the omp harness", () => {
  assert.equal(CLAUDE_OR_CODEX_PRIMARY_ENABLED.length, 10);

  for (const entry of CLAUDE_OR_CODEX_PRIMARY_ENABLED) {
    for (let effort = entry.effort.min; effort <= entry.effort.max; effort++) {
      const argv = buildLaunchArgv({
        harness: HARNESS_NAMES.OMP,
        model: entry.model,
        effort,
      });

      assert.ok(
        argv[0]?.endsWith("ompy"),
        `expected "${entry.model}" at effort ${effort} to launch through ompy, got argv[0]="${argv[0]}"`,
      );
      const modelFlagIndex = argv.indexOf("--model");
      assert.ok(
        modelFlagIndex >= 0 && typeof argv[modelFlagIndex + 1] === "string",
        `expected a --model flag naming the resolved omp model spelling for "${entry.model}"`,
      );
      const resolvedModel = argv[modelFlagIndex + 1];
      assert.ok(
        resolvedModel !== undefined && resolvedModel.length > 0,
        `expected a non-empty resolved model spelling for "${entry.model}"`,
      );

      const thinkingFlagIndex = argv.indexOf("--thinking");
      assert.ok(
        thinkingFlagIndex >= 0,
        `expected a --thinking flag for "${entry.model}" at effort ${effort}`,
      );
      const thinkingToken = argv[thinkingFlagIndex + 1];
      assert.ok(
        thinkingToken !== undefined && thinkingToken.length > 0,
        `expected a non-empty --thinking token for "${entry.model}" at effort ${effort}, got "${thinkingToken}"`,
      );
      assert.ok(
        ["low", "medium", "high", "xhigh", "max"].includes(thinkingToken!),
        `expected a valid omp --thinking rung for "${entry.model}" at effort ${effort}, got "${thinkingToken}"`,
      );
    }
  }
});

test("effort 6 (ultracode/ultra) clamps to omp's own top rung, max", () => {
  const argv = buildLaunchArgv({
    harness: HARNESS_NAMES.OMP,
    model: "opus",
    effort: 6,
  });
  const thinkingFlagIndex = argv.indexOf("--thinking");
  assert.equal(argv[thinkingFlagIndex + 1], "max");
});
