import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RUN_STARTED_AT_ENVIRONMENT_VARIABLE,
  createOutputLineRecorder,
  formatSuiteTimingReport,
  readRunStartedAtMs,
} from "./suite-phase-timings.mjs";

const guardedTestsRunner = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-suite-guarded-tests.mjs");

function runGuardedTestsWithEmptyCommands() {
  const quietCommand = [process.execPath, "-e", ""];
  return spawnSync(process.execPath, [guardedTestsRunner, "--guard", ...quietCommand, "--test", ...quietCommand], {
    encoding: "utf8",
  }).stdout;
}

function recordContainerOutput(chunksByArrivalMs: Array<[number, string]>) {
  let clockMs = 0;
  const recorder = createOutputLineRecorder(() => clockMs);
  for (const [arrivedAtMs, chunk] of chunksByArrivalMs) {
    clockMs = arrivedAtMs;
    recorder.record(chunk);
  }
  return recorder.lines();
}

function reportFor(suiteOutputChunks: Array<[number, string]>, containerExitedAtMs: number) {
  return formatSuiteTimingReport({
    runStartedAtMs: 1000,
    slotHeldAtMs: 4000,
    imageBuild: { startedAtMs: 4100, finishedAtMs: 64100 },
    hostGuards: { startedAtMs: 4200, finishedAtMs: 5000 },
    outputLines: recordContainerOutput(suiteOutputChunks),
    containerExitedAtMs,
    suiteOutput: suiteOutputChunks.map(([, chunk]) => chunk).join(""),
  });
}

test("every run prints one wall-clock line per phase, timed from the run's start", () => {
  const [guardsMark, testsMark, postGuardsMark] = runGuardedTestsWithEmptyCommands().split(/(?<=\n)/);
  const report = reportFor(
    [
      [70000, "suite-run: id=abc runtime=podman\n\n> throne@0.0.0 test:isolated\n"],
      [71000, "> throne@0.0.0 lint:pri"],
      [71001, "vate-refs\n> scripts/lint-private-refs.sh\n\n> throne@0.0.0 lint\n> eslint .\n"],
      [131000, guardsMark],
      [140000, testsMark],
      [600000, "✔ one test (12.5ms)\nℹ tests 1\n"],
      [601000, postGuardsMark],
    ],
    605000,
  );

  assert.deepEqual(report.split("\n").filter((line) => line.startsWith("suite-phase:")), [
    "suite-phase: slot wait from_run_start_ms=0 elapsed_ms=3000",
    "suite-phase: image build from_run_start_ms=3100 elapsed_ms=60000",
    "suite-phase: guards during image build from_run_start_ms=3200 elapsed_ms=800",
    "suite-phase: container start from_run_start_ms=63100 elapsed_ms=6901",
    "suite-phase: lint from_run_start_ms=70001 elapsed_ms=59999",
    "suite-phase: guards from_run_start_ms=130000 elapsed_ms=9000",
    "suite-phase: tests from_run_start_ms=139000 elapsed_ms=461000",
    "suite-phase: post-guards from_run_start_ms=600000 elapsed_ms=4000",
  ]);
});

test("every run prints one wall-clock line per phase even when the run stops before a phase", () => {
  const report = reportFor([[71000, "> throne@0.0.0 lint:private-refs\n✖ 3 problems\n"]], 90000);

  assert.deepEqual(report.split("\n").filter((line) => line.startsWith("suite-phase:")).slice(4), [
    "suite-phase: lint from_run_start_ms=70000 elapsed_ms=19000",
    "suite-phase: guards not reached",
    "suite-phase: tests not reached",
    "suite-phase: post-guards not reached",
  ]);
});

test("every run prints the time spent waiting in each existing lock or wait", () => {
  const report = reportFor([], 70000);

  assert.deepEqual(report.split("\n").filter((line) => line.startsWith("suite-lock-wait:")), [
    "suite-lock-wait: tmpfs slot guard elapsed_ms=3000",
  ]);
  assert.equal(readRunStartedAtMs({ [RUN_STARTED_AT_ENVIRONMENT_VARIABLE]: "1000" }, 4000), 1000);
  assert.equal(readRunStartedAtMs({}, 4000), 4000);
});

test("every run ends by naming its 20 slowest tests with their durations", () => {
  const timedItems = Array.from({ length: 25 }, (_, index) => `✔ test number ${index + 1} (${(index + 1) * 1000}ms)\n`);
  const failingSummary = "✖ failing tests:\n\n✖ test number 25 (25000ms)\n";
  const report = reportFor([[100000, timedItems.join("") + "✖ test number 25 (25000ms)\n" + failingSummary]], 200000);

  const slowestBlock = report.slice(report.indexOf("suite-slowest-tests:")).trimEnd().split("\n");
  assert.equal(slowestBlock[0], "suite-slowest-tests: the 20 slowest timed items (leaf tests and suites alike)");
  assert.deepEqual(slowestBlock.slice(1, 3), ["  1. 25000ms test number 25", "  2. 24000ms test number 24"]);
  assert.equal(slowestBlock.at(-1), "  20. 6000ms test number 6");
  assert.equal(slowestBlock.length, 21);
  assert.ok(report.endsWith("  20. 6000ms test number 6\n"));
});
