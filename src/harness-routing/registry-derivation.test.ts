// Requirement: omp is a recognized runtime harness alongside claude, codex,
// and opencode -- the per-harness derivation tables built from
// `RUNTIME_HARNESSES` must carry an `omp` key, not merely widen the
// `RuntimeHarness` type.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveEffortRanges, deriveHarnessAvailability } from "./registry-derivation.ts";
import type { ModelRegistryEntry } from "./model-registry.ts";

const CLAUDE_PRIMARY_ENTRY: ModelRegistryEntry = {
  model: "sonnet",
  aliases: [],
  harness: "claude",
  harnessAliases: {},
  enabled: true,
  roles: [],
  effort: { min: 1, max: 5, ordinary: 3 },
};

test("omp is a recognized runtime harness alongside claude, codex, and opencode", () => {
  const availability = deriveHarnessAvailability([CLAUDE_PRIMARY_ENTRY]);
  assert.ok("omp" in availability, "deriveHarnessAvailability must key omp");

  const effortRanges = deriveEffortRanges([CLAUDE_PRIMARY_ENTRY]);
  assert.ok("omp" in effortRanges, "deriveEffortRanges must key omp");
});
