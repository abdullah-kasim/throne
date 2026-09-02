// The Lord's order, 2026-08-25: "create-agent for alpha and shadow requires
// the objective code to exist in the queue table", then "remove
// bypass-objective-code".
//
// The gate already existed; --bypass-objective-code let callers past it,
// recording bypassedObjectiveCode: true on the launch ledger. It worked as
// designed and the design was withdrawn, after a live Alpha and its Shadow
// ran against objective `hyd` with no queue row anywhere: invisible to
// render-queue, absent from the autoscaler's ready queue, yet still consuming
// a live-Alpha slot against the floor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlags } from "../src/create-agent/request-arguments.ts";

test("--bypass-objective-code is refused, and the refusal says why it went", () => {
  let error: unknown;
  try {
    parseFlags([
      "--role",
      "Alpha",
      "--name",
      "alpha-xyz-thing",
      "--bypass-objective-code",
    ]);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error, "the flag must be refused, not ignored");
  // Silently ignoring it would still fail closed at the gate, but for a
  // reason the caller could not connect to what they typed.
  assert.doesNotMatch(error.message, /^unknown flag/, error.message);
  assert.match(error.message, /removed on the Lord's order, 2026-08-25/);
  assert.match(error.message, /exist in the queue table/);
  assert.match(error.message, /only the Lord may authorise a row/);
});

test("a genuinely unknown flag still gets the plain message", () => {
  assert.throws(
    () => parseFlags(["--role", "Alpha", "--not-a-real-flag"]),
    /unknown flag "--not-a-real-flag"/,
  );
});

test("the flag is gone from the boolean set, so it cannot be silently accepted", () => {
  // Belt and braces: if someone re-adds it to FLAG_NAMES without re-adding the
  // gate branch, the parse above would start succeeding and the launch would
  // fail later for an unrelated-looking reason.
  assert.throws(
    () => parseFlags(["--bypass-objective-code", "true"]),
    /bypass-objective-code/,
  );
});
