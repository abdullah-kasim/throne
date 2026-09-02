import assert from "node:assert/strict";
import test from "node:test";
import {
  TEN_SECOND_LAW_THRESHOLD_MS,
  findTenSecondLawViolations,
  formatTenSecondLawViolationLine,
  parseTestItemDurationsMs,
} from "./suite-duration-gate.mjs";

test("parseTestItemDurationsMs reads every timed item line from a captured node --test run, leaf and suite alike", () => {
  const suiteOutput = [
    "✔ fast one (6.571134ms)",
    "✔ slow one (12000.5ms)",
    "▶ suite group",
    "  ✔ nested a (5.03513ms)",
    "✔ suite group (5.474368ms)",
    "ℹ tests 4",
  ].join("\n");

  assert.deepEqual(parseTestItemDurationsMs(suiteOutput), [
    { name: "fast one", durationMs: 6.571134 },
    { name: "slow one", durationMs: 12000.5 },
    { name: "nested a", durationMs: 5.03513 },
    { name: "suite group", durationMs: 5.474368 },
  ]);
});

test("findTenSecondLawViolations flags an item reported over the ten-second threshold", () => {
  const violations = findTenSecondLawViolations([
    { name: "slow one", durationMs: 12000 },
    { name: "fast one", durationMs: 9000 },
  ]);

  assert.deepEqual(violations, [
    {
      name: "slow one",
      durationMs: 12000,
      thresholdMs: TEN_SECOND_LAW_THRESHOLD_MS,
    },
  ]);
});

test("findTenSecondLawViolations does not flag an item under the ten-second threshold", () => {
  const violations = findTenSecondLawViolations([
    { name: "fast one", durationMs: 9000 },
  ]);

  assert.deepEqual(violations, []);
});

test("findTenSecondLawViolations applies zero margin: an item exactly at the threshold is not a violation", () => {
  const violations = findTenSecondLawViolations([
    { name: "exactly ten seconds", durationMs: TEN_SECOND_LAW_THRESHOLD_MS },
  ]);

  assert.deepEqual(violations, []);
});

test("formatTenSecondLawViolationLine names both the measured duration and the threshold", () => {
  const line = formatTenSecondLawViolationLine({
    name: "slow one",
    durationMs: 12000,
    thresholdMs: TEN_SECOND_LAW_THRESHOLD_MS,
  });

  assert.match(line, /12000ms/);
  assert.match(line, /10000ms/);
  assert.match(line, /slow one/);
});
