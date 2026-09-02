// Decides whether a completed suite run's captured output reports any test
// item over the ten-second bound, distinct from countTestsExecuted's
// pass/fail-count parse of the same suiteOutput string in
// suite-test-verdict.mjs — this is a sibling parse of that same string, not
// a second capture path.
//
// Node's default (spec) reporter prints one line per timed item — leaf
// tests AND their containing suites alike, each ending in
// "(<duration>ms)", prefixed with a pass/fail glyph (✔/✖) and indented when
// nested. This module treats every such line as a "test item" for the
// law's purposes; it does not attempt to tell a leaf test apart from a
// suite-aggregate line, since the reporter's plain-text output does not
// reliably expose that structure.
const TEST_ITEM_DURATION_LINE = /^[\s\S]*?[✔✖]\s+(.+?) \(([\d.]+)ms\)$/gm;

// Zero margin, on purpose: the Lord was told this bound risks flakiness
// under contention (the same suite has measured 7.6–13.5 minutes end to end
// in one day) and reaffirmed the literal ten-second-per-item bound anyway,
// closing that objection. Adding margin here would re-litigate a decision
// the Lord already reaffirmed.
export const TEN_SECOND_LAW_THRESHOLD_MS = 10000;

// Distinct from ZERO_TESTS_EXECUTED_EXIT_CODE (suite-test-verdict.mjs) and
// from whatever `node --test` itself returned — its own reserved code so a
// caller reading only the exit status can tell "a test item broke the
// ten-second law" apart from every other failure class, even on a run
// where the underlying test process itself exited 0.
export const TEN_SECOND_LAW_VIOLATION_EXIT_CODE = 4;

export function parseTestItemDurationsMs(suiteOutput) {
  const items = [];
  for (const match of suiteOutput.matchAll(TEST_ITEM_DURATION_LINE)) {
    items.push({ name: match[1], durationMs: Number(match[2]) });
  }
  return items;
}

export function findTenSecondLawViolations(
  items,
  thresholdMs = TEN_SECOND_LAW_THRESHOLD_MS,
) {
  return items
    .filter((item) => item.durationMs > thresholdMs)
    .map((item) => ({ ...item, thresholdMs }));
}

export function formatTenSecondLawViolationLine(violation) {
  return `run-suite-container: ten-second law violation: "${violation.name}" ran for ${violation.durationMs}ms, exceeding the ${violation.thresholdMs}ms (ten second) threshold\n`;
}

/**
 * Forces a dedicated nonzero exit status onto an otherwise-passing `status`
 * when the captured suite output reports any item over the ten-second
 * bound — mirroring how run-suite-container.mjs's own
 * `suiteExitedCleanWithoutRunningTests` already forces a nonzero outcome
 * for a different failure class. The law binds the ordinary suite command
 * only: `isHeavyTier` (THRONE_HEAVY_TESTS, set by test:heavy's own npm
 * script) suppresses the check entirely, leaving test:heavy's own
 * --test-timeout=600000 as the bound for its legitimately long real-infra
 * items.
 */
export function applyTenSecondLawGate(
  status,
  suiteOutput,
  { isHeavyTier, writeViolation },
) {
  if (isHeavyTier) return status;
  const violations = findTenSecondLawViolations(
    parseTestItemDurationsMs(suiteOutput),
  );
  if (violations.length === 0) return status;
  for (const violation of violations) {
    writeViolation(formatTenSecondLawViolationLine(violation));
  }
  return TEN_SECOND_LAW_VIOLATION_EXIT_CODE;
}
