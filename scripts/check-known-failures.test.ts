import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compareAgainstKnownFailures, parseFailingTests } from "./check-known-failures.mjs";

const TWENTY_FOUR_FAILURES_LOG = new URL("../test/fixtures/spec-reporter-24-failing-tests.log", import.meta.url);
const KILLED_TEST_FILE_LOG = new URL("../test/fixtures/spec-reporter-killed-test-file.log", import.meta.url);

test("the failing test names are read from the suite's own output format", async () => {
  const suiteOutput = await readFile(TWENTY_FOUR_FAILURES_LOG, "utf8");

  const failingTests = parseFailingTests(suiteOutput);
  const comparison = compareAgainstKnownFailures(suiteOutput, new Set(["every shipped skill is documented in docs/THRONE_SKILLS.md"]));

  assert.equal(failingTests.length, 24);
  assert.deepEqual(failingTests[0], {
    file: "src/memory-recall/recall-report-scope.spec.ts",
    name: "a dig that finds a relevant memory inside the searched scope counts as missed-and-found",
  });
  assert.equal(comparison.nonPassingNames.size, 24);
  assert.equal(comparison.unlistedNames.length, 23);
  assert.ok(!comparison.unlistedNames.includes("every shipped skill is documented in docs/THRONE_SKILLS.md"));
  assert.deepEqual(comparison.namesNotSeenFailing, []);
  assert.deepEqual(comparison.counts, { failed: 24, cancelled: 0 });
});

test("a killed test file is read as one failing test named after the file", async () => {
  const suiteOutput = await readFile(KILLED_TEST_FILE_LOG, "utf8");

  const failingTests = parseFailingTests(suiteOutput);

  assert.equal(failingTests.length, 25);
  assert.ok(
    failingTests.some(
      (failingTest) =>
        failingTest.file === "test/forge-given-pr-skills.test.ts" && failingTest.name === "test/forge-given-pr-skills.test.ts",
    ),
  );
});
