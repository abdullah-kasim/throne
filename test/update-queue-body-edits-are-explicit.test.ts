// `--body` replaced the stored body silently, and on 2026-08-25 that ate a
// Regent's HELD banner off four rows: the amending Stager had no
// non-destructive verb available, so it passed whole new text and the reason
// those rows were held vanished. These tests pin the three corrections —
// amend-without-replacing exists, the destructive verb is spelled with its
// verb, and a replace says what it dropped.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeReplacedBody,
  parseUpdateQueueArgs,
  resolveBodyEdit,
} from "../src/update-queue/update-queue-runtime.ts";

test("--prepend-body and --append-body keep the stored body", () => {
  const stored = "HELD: not launch-eligible until Phase 0 passes.";
  assert.equal(
    resolveBodyEdit(stored, { mode: "prepend", text: "AMENDED: no human blocks." }),
    "AMENDED: no human blocks.\n\nHELD: not launch-eligible until Phase 0 passes.",
  );
  assert.equal(
    resolveBodyEdit(stored, { mode: "append", text: "AMENDED: no human blocks." }),
    "HELD: not launch-eligible until Phase 0 passes.\n\nAMENDED: no human blocks.",
  );
});

test("--replace-body discards it, which is the whole point of the name", () => {
  assert.equal(
    resolveBodyEdit("old text", { mode: "replace", text: "new text" }),
    "new text",
  );
});

test("--body still parses, and is flagged as the verb-less spelling", () => {
  const legacy = parseUpdateQueueArgs(["--objective-code", "uqv", "--body", "x"]);
  assert.deepEqual(legacy.bodyEdit, { mode: "replace", text: "x" });
  assert.equal(legacy.usedLegacyBodyFlag, true);

  const explicit = parseUpdateQueueArgs([
    "--objective-code",
    "uqv",
    "--replace-body",
    "x",
  ]);
  assert.deepEqual(explicit.bodyEdit, { mode: "replace", text: "x" });
  assert.equal(explicit.usedLegacyBodyFlag, undefined);
});

test("two body edits at once are refused rather than silently last-wins", () => {
  assert.throws(
    () =>
      parseUpdateQueueArgs([
        "--objective-code",
        "uqv",
        "--prepend-body",
        "a",
        "--append-body",
        "b",
      ]),
    /exactly one body edit/,
  );
});

test("a replace reports the load-bearing markers it dropped", () => {
  // The exact 2026-08-25 shape: a HELD banner plus a plan body, replaced by a
  // plan body alone.
  const notice = describeReplacedBody(
    "HELD — not launch-eligible.\n\nINTENT: x\nSCOPE: y\nRULINGS: z\nVERIFIED-NOUNS: w",
    "INTENT: x\nSCOPE: y\nRULINGS: z\nVERIFIED-NOUNS: w",
  );
  assert.match(notice ?? "", /DROPPED 1 load-bearing marker/);
  assert.match(notice ?? "", /HELD/);
  assert.match(notice ?? "", /--prepend-body/);
});

test("a replace that drops nothing load-bearing still says the old text is gone", () => {
  const notice = describeReplacedBody("INTENT: a", "INTENT: b");
  assert.match(notice ?? "", /The previous text is gone/);
  assert.doesNotMatch(notice ?? "", /DROPPED/);
});

test("an identical replace reports nothing", () => {
  assert.equal(describeReplacedBody("same", "same"), undefined);
});
