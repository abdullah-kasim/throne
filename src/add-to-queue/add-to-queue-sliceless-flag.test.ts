import assert from "node:assert/strict";
import { test } from "node:test";
import { executionModeSuffix, parseAddToQueueArgs } from "./add-to-queue-runtime.ts";

test("a row filed with --sliceless is parsed as sliceless and, because sliceless implies shadowless, as shadowless too", () => {
  const parsed = parseAddToQueueArgs([
    "--objective-code",
    "slc",
    "--target-repo",
    "/tmp/example-target",
    "--sliceless",
    "INTENT:",
    "fix",
    "one",
    "function",
  ]);
  assert.equal(parsed.sliceless, true);
  assert.equal(parsed.shadowless, true);
  assert.equal(parsed.body, "INTENT: fix one function");
});

test("a row filed with --shadowless alone is not sliceless", () => {
  const parsed = parseAddToQueueArgs([
    "--objective-code",
    "shl",
    "--target-repo",
    "/tmp/example-target",
    "--shadowless",
    "INTENT:",
    "run",
  ]);
  assert.equal(parsed.shadowless, true);
  assert.equal("sliceless" in parsed, false);
});

test("filing a sliceless row prints that it implies shadowless", () => {
  assert.equal(
    executionModeSuffix({ sliceless: true, shadowless: true }),
    "; SLICELESS (implies shadowless), Lord-authorized",
  );
  assert.equal(executionModeSuffix({ shadowless: true }), "; SHADOWLESS, Lord-authorized");
  assert.equal(executionModeSuffix({}), "");
});
