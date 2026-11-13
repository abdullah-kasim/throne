import test from "node:test";
import assert from "node:assert/strict";
import { formatJunitSummary } from "./junit-test-summary.ts";
import { countTestsExecuted } from "../scripts/suite-test-verdict.mjs";
import { parseTestItemDurationsMs } from "../scripts/suite-duration-gate.mjs";
import { parseFailingTests, parseSuiteFailCancelledCounts } from "../scripts/check-known-failures.mjs";

const report = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3">
  <testsuite name="a.test.ts" file="a.test.ts">
    <testcase name="waits &lt;long&gt;" classname="" time="12.3456" file="a.test.ts" line="3" assertions="0" />
    <testsuite name="group" file="a.test.ts" line="4">
      <testcase name="skipped one" classname="group" time="0" file="a.test.ts" line="5" assertions="0">
        <skipped />
      </testcase>
    </testsuite>
  </testsuite>
  <testsuite name="b.test.ts" file="b.test.ts">
    <testcase name="says &quot;no&quot; &amp; fails" classname="" time="0.00309" file="b.test.ts" line="2" assertions="0">
      <failure type="AssertionError" message="1 == 2">AssertionError: 1 == 2&#10;</failure>
    </testcase>
  </testsuite>
</testsuites>
`;

test("a Bun JUnit report becomes the summary lines the suite verdict, the ten-second law and the known-failure check read", () => {
  const summary = formatJunitSummary(report);

  assert.equal(countTestsExecuted(summary), 3);
  assert.deepEqual(parseTestItemDurationsMs(summary), [
    { name: "waits <long>", durationMs: 12345.6 },
    { name: 'says "no" & fails', durationMs: 3.09 },
    { name: 'says "no" & fails', durationMs: 3.09 },
  ]);
  assert.deepEqual(parseFailingTests(summary), [{ file: "b.test.ts", name: 'says "no" & fails' }]);
  assert.deepEqual(parseSuiteFailCancelledCounts(summary), { failed: 1, cancelled: 0 });
  assert.match(summary, /^ℹ pass 1$/m);
  assert.match(summary, /^ℹ skipped 1$/m);
});
