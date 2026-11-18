import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSteeringOverride } from "../src/steering-user-config.ts";
import { parseHarness } from "../src/harness-routing/model-registry.ts";
import { prepareCreateAgentRequest } from "../src/create-agent/request.ts";
import { prepareCreateAgentRequest as prepareLegacyCreateAgentRequest } from "../src/create-agent-legacy/request.ts";

const SOURCE = "/checkout/config.user.ts";
const REMOVED_AND_POINTS_AT_PI = /omp harness was removed.*use the pi harness/;

test("a config that names the omp harness as the active harness is refused and points at pi", () => {
  assert.throws(
    () => validateSteeringOverride({ activeHarness: "omp" }, SOURCE),
    REMOVED_AND_POINTS_AT_PI,
  );
});

test("a config whose Stager pool names the omp harness is refused and points at pi", () => {
  assert.throws(
    () => validateSteeringOverride({ stagerPool: [{ harness: "omp", model: "opus" }] }, SOURCE),
    REMOVED_AND_POINTS_AT_PI,
  );
});

test("a config preset pool that names the omp harness is refused and points at pi", () => {
  assert.throws(
    () =>
      validateSteeringOverride(
        { customPlanPresets: { OmpTrial: { alpha: [{ harness: "omp", model: "sonnet" }] } } },
        SOURCE,
      ),
    REMOVED_AND_POINTS_AT_PI,
  );
});

test("a stored record naming the omp harness is refused and points at pi", () => {
  assert.throws(() => parseHarness("omp"), REMOVED_AND_POINTS_AT_PI);
});

for (const [command, prepare] of [
  ["create-agent", prepareCreateAgentRequest],
  ["create-agent-legacy", prepareLegacyCreateAgentRequest],
] as const) {
  test(`asking ${command} for the omp harness is refused and points at pi`, async () => {
    const errors: string[] = [];
    const result = await prepare(
      ["--harness", "omp", "--model", "opus", "--name", "shadow-x-01", "--supervisor", "alpha-x-01"],
      { writeStderr: (text: string) => errors.push(text) } as Parameters<typeof prepare>[1],
      "/checkout",
    );
    assert.equal(result.ok, false);
    assert.match(errors.join(""), REMOVED_AND_POINTS_AT_PI);
  });
}

test("a harness named after a built-in object property is not mistaken for a removed harness", () => {
  assert.throws(() => parseHarness("constructor"), (error: Error) => !/was removed/.test(error.message));
  assert.throws(() => parseHarness("toString"), (error: Error) => !/was removed/.test(error.message));
});
