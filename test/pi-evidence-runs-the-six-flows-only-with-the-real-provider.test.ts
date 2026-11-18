import assert from "node:assert/strict";
import { test } from "node:test";
import { lines, tokensSpent } from "../scripts/pi-evidence/lines/flows.mjs";
import { skippedLineReason } from "../scripts/pi-evidence/support.mjs";

test("the pi evidence tool lists the six flows among the lines it runs, each only with the real provider", () => {
  assert.deepEqual(lines.map((line) => line.id), ["F1", "F2", "F3", "F4", "F5", "F6"]);
  for (const line of lines) {
    assert.equal(skippedLineReason(line, { realProvider: false, realHarnesses: false }), "real provider line; run with --real-provider");
    assert.equal(skippedLineReason(line, { realProvider: true, realHarnesses: false }), null);
  }
});

test("a flow's token cost is summed from the usage pi records in its session", () => {
  const records = [
    { type: "message", message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 5, totalTokens: 125 } } },
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", usage: { input: 10, output: 2, cacheRead: 0 } } },
  ];
  assert.deepEqual(tokensSpent(records), { input: 110, output: 22, cacheRead: 5, total: 137 });
});
