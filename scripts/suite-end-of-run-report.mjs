import {
  NO_LISTED_TEST_FILES_NOTICE,
  allTestGroups,
  containerTestGroup,
  isTestGroupEnabled,
  slowTestGroup,
} from "../test/heavy-tests-gate.ts";
import { applyTenSecondLawGate } from "./suite-duration-gate.mjs";
import {
  ZERO_TESTS_EXECUTED_EXIT_CODE,
  countTestsExecuted,
  formatTestsExecutedLine,
  suiteExitedCleanWithoutRunningTests,
} from "./suite-test-verdict.mjs";

export function isTenSecondLawExempt(environment) {
  return allTestGroups.some((group) => isTestGroupEnabled(group, environment));
}

function countDistinctSkippedFiles(suiteOutput, group) {
  const skipNoticePrefix = group.skipNotice("");
  const skippedFiles = new Set();
  for (const line of suiteOutput.split("\n")) {
    const noticeAt = line.indexOf(skipNoticePrefix);
    if (noticeAt !== -1) skippedFiles.add(line.slice(noticeAt + skipNoticePrefix.length).trim());
  }
  return skippedFiles.size;
}

export function countSkippedTestFiles(suiteOutput) {
  return {
    slow: countDistinctSkippedFiles(suiteOutput, slowTestGroup),
    container: countDistinctSkippedFiles(suiteOutput, containerTestGroup),
  };
}

export function formatSkippedTestFilesLine({ slow, container }) {
  return `run-suite-container: skipped test files: ${slow} slow, ${container} container\n`;
}

export function enabledGroupsListNoTestFiles(suiteOutput) {
  return suiteOutput.split("\n").some((line) => line.trim() === NO_LISTED_TEST_FILES_NOTICE);
}

export function formatSuiteOutcomeLine({ status, lawExempt, violationCount }) {
  const testsOutcome = status === 0 ? "tests passed" : `tests failed (exit ${status})`;
  const lawOutcome = lawExempt
    ? "ten-second law not applied to a slow, container or heavy run"
    : violationCount === 0
      ? "ten-second law kept"
      : `ten-second law broken by ${violationCount} test item(s)`;
  return `run-suite-container: outcome: ${testsOutcome}; ${lawOutcome}\n`;
}

export function reportEndOfSuiteRun(status, suiteOutput, environment, { writeOutput, writeError }) {
  const executedCount = countTestsExecuted(suiteOutput);
  writeOutput(formatTestsExecutedLine(executedCount));
  writeOutput(formatSkippedTestFilesLine(countSkippedTestFiles(suiteOutput)));
  if (status === 0 && executedCount === undefined && enabledGroupsListNoTestFiles(suiteOutput)) {
    writeOutput("run-suite-container: the enabled test groups list no test files, so there was nothing to run\n");
    return 0;
  }
  if (suiteExitedCleanWithoutRunningTests(status, executedCount)) {
    writeError(
      executedCount === undefined
        ? "run-suite-container: suite exited 0 but no test-runner \"tests N\" summary was found in its output — refusing to report success for a run whose test count cannot be confirmed\n"
        : "run-suite-container: suite exited 0 but executed zero tests — refusing to report success; check the test globs actually matched files\n",
    );
    return ZERO_TESTS_EXECUTED_EXIT_CODE;
  }
  const lawExempt = isTenSecondLawExempt(environment);
  let violationCount = 0;
  const exitCode = applyTenSecondLawGate(status, suiteOutput, {
    isExempt: lawExempt,
    writeViolation: (line) => {
      violationCount += 1;
      writeError(line);
    },
  });
  writeOutput(formatSuiteOutcomeLine({ status, lawExempt, violationCount }));
  return exitCode;
}
