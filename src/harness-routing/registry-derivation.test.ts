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

test("pi is a derived runtime harness and the removed omp harness is not", () => {
  const availability = deriveHarnessAvailability([CLAUDE_PRIMARY_ENTRY]);
  assert.ok("pi" in availability, "deriveHarnessAvailability must key pi");
  assert.ok(!("omp" in availability), "deriveHarnessAvailability must not key omp");

  const effortRanges = deriveEffortRanges([CLAUDE_PRIMARY_ENTRY]);
  assert.ok("pi" in effortRanges, "deriveEffortRanges must key pi");
  assert.ok(!("omp" in effortRanges), "deriveEffortRanges must not key omp");
});
