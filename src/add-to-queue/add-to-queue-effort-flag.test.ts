import assert from "node:assert/strict";
import { test } from "node:test";
import { effortToken } from "../harness-routing/harness.ts";
import { parseAddToQueueArgs } from "./add-to-queue-runtime.ts";

function fileWithEffort(effort: string) {
  return parseAddToQueueArgs([
    "--objective-code",
    "eff",
    "--target-repo",
    "/tmp/example-target",
    "--effort",
    effort,
    "INTENT:",
    "run",
  ]);
}

test("a queue row filed at high effort stores the effort that launches the harness at its high setting", () => {
  assert.equal(effortToken("claude", fileWithEffort("high").effort!), "high");
});

test("the level names a queue row accepts come from the same table the harness launch uses", () => {
  for (const name of ["low", "medium", "high", "xhigh", "max"])
    assert.equal(effortToken("claude", fileWithEffort(name).effort!), name);
  assert.deepEqual(
    ["low", "medium", "high", "xhigh", "max"].map((name) => fileWithEffort(name).effort),
    [1, 2, 3, 4, 5],
  );
});

test("a queue row filed with a numeric effort from 1 to 6 stores that number", () => {
  for (const effort of [1, 2, 3, 4, 5, 6])
    assert.equal(fileWithEffort(String(effort)).effort, effort);
  const withoutEffort = parseAddToQueueArgs([
    "--objective-code",
    "none",
    "--target-repo",
    "/tmp/example-target",
    "INTENT:",
    "run",
  ]);
  assert.equal("effort" in withoutEffort, false);
});

test("a queue row cannot be filed with an effort outside 1 to 6 or an unknown level name", () => {
  for (const effort of ["0", "7", "4.5", "ultracode", "extreme", ""])
    assert.throws(
      () => fileWithEffort(effort),
      /is not an effort: use a number from 1 to 6 or one of low, medium, high, xhigh, max/,
    );
});
