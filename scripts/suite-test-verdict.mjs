// Decides and reports whether a completed suite run genuinely executed tests.
// — the process genuinely started and finished cleanly, so nothing
// downstream has anything to interpret as failure. Node's own default/TAP
// reporters both end a run with a "tests N" summary line; parsing it out of
// the suite's real output is what lets a caller tell "ran clean" apart from
// "ran nothing."

// Distinct from a genuine test-failure exit (whatever `node --test` itself
// returns) and from a genuine SuiteSignalError death (re-raised as the real
// signal, never a plain exit code) — this is its own reserved code so a
// caller reading only the exit status, not the stderr message, can still
// tell "the suite ran and something failed" apart from "the suite never
// actually ran any tests."
export const ZERO_TESTS_EXECUTED_EXIT_CODE = 3;

const TESTS_EXECUTED_SUMMARY = /^(?:#|ℹ) tests (\d+)$/m;

export function countTestsExecuted(suiteOutput) {
  const summary = suiteOutput.match(TESTS_EXECUTED_SUMMARY);
  return summary ? Number(summary[1]) : undefined;
}

export function suiteExitedCleanWithoutRunningTests(status, executedCount) {
  return status === 0 && !executedCount;
}

// The greppable line every real run's own stdout carries, whether the count
// is a genuine `0` (the runner started, ran, and matched nothing — the exact
// case `suiteExitedCleanWithoutRunningTests` demotes above) or `undefined`
// ("unknown": no "tests N" summary was found in the output at all, e.g. the
// run never reached node --test). Kept apart from `countTestsExecuted` so it
// can be unit-tested against real runRealNodeTest output without starting the
// full suite composition it is used inside.
export function formatTestsExecutedLine(executedCount) {
  return `run-suite-container: tests executed: ${
    executedCount === undefined ? "unknown" : executedCount
  }\n`;
}
