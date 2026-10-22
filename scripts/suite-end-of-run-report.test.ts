import assert from "node:assert/strict";
import test from "node:test";
import { compareAgainstKnownFailures } from "./check-known-failures.mjs";
import { reportEndOfSuiteRun } from "./suite-end-of-run-report.mjs";
import { TEN_SECOND_LAW_VIOLATION_EXIT_CODE } from "./suite-duration-gate.mjs";
import { ZERO_TESTS_EXECUTED_EXIT_CODE } from "./suite-test-verdict.mjs";
import { NO_LISTED_TEST_FILES_NOTICE } from "../test/heavy-tests-gate.ts";

function reportRun(status: number, suiteOutput: string, environment: Record<string, string> = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = reportEndOfSuiteRun(status, suiteOutput, environment, {
    writeOutput: (line: string) => output.push(line),
    writeError: (line: string) => errors.push(line),
  });
  return { exitCode, output: output.join(""), errors: errors.join("") };
}

const slowItemOutput = "✔ a test that waits too long (12345.6ms)\n✔ a quick test (4.2ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0\n";

test("a default run with a test over ten seconds fails and names the test, its duration and the threshold", () => {
  const run = reportRun(0, slowItemOutput);

  assert.equal(run.exitCode, TEN_SECOND_LAW_VIOLATION_EXIT_CODE);
  assert.match(run.errors, /ten-second law violation: "a test that waits too long" ran for 12345\.6ms, exceeding the 10000ms \(ten second\) threshold/);
  assert.doesNotMatch(run.errors, /a quick test/);
  assert.deepEqual(
    compareAgainstKnownFailures(run.output + run.errors, new Set(["a test that waits too long"])).tenSecondLawViolationNames,
    ["a test that waits too long"],
  );
});

test("a slow, container or heavy run is not failed by the ten-second law", () => {
  for (const environmentVariable of ["THRONE_SLOW_TESTS", "THRONE_CONTAINER_TESTS", "THRONE_HEAVY_TESTS"]) {
    const run = reportRun(0, slowItemOutput, { [environmentVariable]: "1" });

    assert.equal(run.exitCode, 0, environmentVariable);
    assert.equal(run.errors, "", environmentVariable);
    assert.match(run.output, /outcome: tests passed; ten-second law not applied to a slow, container or heavy run/);
  }
});

test("a run with failing tests and law violations reports both", () => {
  const run = reportRun(1, slowItemOutput.replace("✔ a quick test", "✖ a quick test"));

  assert.notEqual(run.exitCode, 0);
  assert.match(run.output, /outcome: tests failed \(exit 1\); ten-second law broken by 1 test item\(s\)\n/);
  assert.match(run.errors, /ten-second law violation: "a test that waits too long"/);
});

test("the end of every run says how many slow and container test files were skipped", () => {
  const suiteOutput = [
    "# slow test file skipped: test/install-forgejo-sh.test.ts",
    "ℹ # slow test file skipped: test/push-checks.test.ts",
    "# slow test file skipped: test/push-checks.test.ts",
    "# container test file skipped: test/a-container.test.ts",
    "✔ a quick test (4.2ms)",
    "ℹ tests 1",
  ].join("\n");

  assert.match(reportRun(0, suiteOutput).output, /skipped test files: 2 slow, 1 container\n/);
  assert.match(reportRun(0, slowItemOutput).output, /skipped test files: 0 slow, 0 container\n/);
});

test("an enabled group that lists no test files succeeds and says so, while a default run that executes nothing is still refused", () => {
  const emptyGroupRun = reportRun(0, `${NO_LISTED_TEST_FILES_NOTICE}\n`, { THRONE_CONTAINER_TESTS: "1" });
  assert.equal(emptyGroupRun.exitCode, 0);
  assert.match(emptyGroupRun.output, /the enabled test groups list no test files/);

  assert.equal(reportRun(0, "ℹ tests 0\n").exitCode, ZERO_TESTS_EXECUTED_EXIT_CODE);
  assert.equal(reportRun(0, "no summary at all\n").exitCode, ZERO_TESTS_EXECUTED_EXIT_CODE);
});

test("the outcome line names a test file the watchdog killed past its time limit, and not one that exited before the kill", () => {
  const suiteOutput = [
    "suite-test-file-watchdog: test file past its time limit: test/hangs.test.ts ran 300.4s against a 300.0s limit",
    "suite-test-file-watchdog: killed test file: test/hangs.test.ts",
    "suite-test-file-watchdog: test file past its time limit: test/slow-start.test.ts ran 300.1s against a 300.0s limit",
    "suite-test-file-watchdog: test/slow-start.test.ts exited on its own before it could be killed",
    "ℹ tests 3",
  ].join("\n");

  assert.match(reportRun(1, suiteOutput).output, /outcome: tests failed \(exit 1\); ten-second law kept; killed past the per-file time limit: test\/hangs\.test\.ts\n/);
  assert.match(reportRun(1, "ℹ tests 3\n").output, /outcome: tests failed \(exit 1\); ten-second law kept\n/);
});
