import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAddToQueueArgs } from "./add-to-queue-runtime.ts";

test("--shadowless marks the parsed queue item as Lord-authorized shadowless", () => {
  const parsed = parseAddToQueueArgs([
    "--objective-code",
    "shl",
    "--target-repo",
    "/tmp/example-target",
    "--shadowless",
    "INTENT:",
    "run",
    "without",
    "shadows",
  ]);
  assert.equal(parsed.shadowless, true);
  assert.equal(parsed.body, "INTENT: run without shadows");
});

test("a row filed without --shadowless carries no shadowless field at all", () => {
  const parsed = parseAddToQueueArgs([
    "--objective-code",
    "ord",
    "--target-repo",
    "/tmp/example-target",
    "INTENT:",
    "ordinary",
  ]);
  assert.equal("shadowless" in parsed, false);
});
