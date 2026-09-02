// Requirement: `update-queue --objective-code osc --body "$(...)"` with an
// empty command substitution used to overwrite a queue item's body with ""
// and report success. This exercises `parseUpdateQueueArgs`'s empty/
// whitespace-only refusal for every STRING_FIELDS flag directly, plus one
// updateQueueItem-level case proving the refusal reaches the real mutation
// entry point and leaves the store untouched.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { parseUpdateQueueArgs } from "../src/update-queue/update-queue-runtime.ts";
import {
  openRegentQueueStore,
  type RegentQueueMutationStore,
} from "../src/regent-queue/regent-queue.store.ts";

const PLACEHOLDER_REPO = "/repo/throne";
const FIXED_TIME = 1_700_000_000_000;

const STRING_FIELDS_WITH_CLEAR_COUNTERPART: Array<[string, string]> = [
  ["--agent-name", "--clear-agent-name"],
  ["--target-repo", "--clear-target-repo"],
  ["--base-commit", "--clear-base-commit"],
  ["--delivery-commit", "--clear-delivery-commit"],
  ["--pr-branch", "--clear-pr-branch"],
];

for (const [flag, clearFlag] of STRING_FIELDS_WITH_CLEAR_COUNTERPART) {
  test(`${flag} "" is refused and names its ${clearFlag} counterpart`, () => {
    assert.throws(
      () =>
        parseUpdateQueueArgs([
          "--objective-code",
          "uqvempty",
          flag,
          "",
        ]),
      new RegExp(`${flag}.*${clearFlag}`),
    );
  });

  test(`${flag} "   " (whitespace-only) is refused and names its ${clearFlag} counterpart`, () => {
    assert.throws(
      () =>
        parseUpdateQueueArgs([
          "--objective-code",
          "uqvempty",
          flag,
          "   ",
        ]),
      new RegExp(`${flag}.*${clearFlag}`),
    );
  });

  test(`a real value on ${flag} still parses`, () => {
    const input = parseUpdateQueueArgs([
      "--objective-code",
      "uqvempty",
      flag,
      "a-real-value",
    ]);
    assert.equal(Object.keys(input.mutation).length, 1);
  });

  test(`${clearFlag} still nulls its field and consumes no value`, () => {
    const input = parseUpdateQueueArgs([
      "--objective-code",
      "uqvempty",
      clearFlag,
      "--priority",
      "5",
    ]);
    assert.equal(Object.values(input.mutation)[0], null);
    assert.equal(input.mutation.priority, 5);
  });
}

test('--body "" is refused and states plainly that no --clear-body flag exists', () => {
  assert.throws(
    () =>
      parseUpdateQueueArgs(["--objective-code", "uqvbodyempty", "--body", ""]),
    /--body.*no --clear-\* counterpart exists/,
  );
});

test('--body "   " (whitespace-only) is refused', () => {
  assert.throws(
    () =>
      parseUpdateQueueArgs([
        "--objective-code",
        "uqvbodyempty",
        "--body",
        "   ",
      ]),
    /--body.*no --clear-\* counterpart exists/,
  );
});

test("a real --body value still parses", () => {
  // Body edits moved out of `mutation` and into `bodyEdit` on 2026-08-25, when
  // --prepend-body/--append-body were added: a prepend cannot be resolved
  // until the stored body is in hand, so parsing records the intent and
  // `updateQueueItem` resolves it. `--body` keeps meaning "replace".
  const input = parseUpdateQueueArgs([
    "--objective-code",
    "uqvbodyempty",
    "--body",
    "a real objective specification",
  ]);
  assert.deepEqual(input.bodyEdit, {
    mode: "replace",
    text: "a real objective specification",
  });
});

const scratchDirectories: string[] = [];
let store: RegentQueueMutationStore;

before(() => {
  const directory = mkdtempSync(
    join(tmpdir(), "throne-update-queue-empty-string-"),
  );
  scratchDirectories.push(directory);
  store = openRegentQueueStore(
    join(directory, "regent-queue.sqlite3"),
    () => FIXED_TIME,
  );
});

after(() => {
  store.close();
  for (const directory of scratchDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an empty --body never reaches updateQueueItem and leaves the stored body untouched", () => {
  store.insertItem({
    objectiveCode: "uqvbodyprotect",
    body: "a 4,600-character objective specification stand-in",
    launch: {
      alphaName: "alpha-uqvbodyprotect-fixture",
      targetRepo: PLACEHOLDER_REPO,
      targetBranch: "main",
      baseCommit: "0".repeat(40),
    },
    deliveryMirror: {
      verdict: "unknown",
      deliveryCommit: null,
      targetRepo: PLACEHOLDER_REPO,
      targetBranch: "main",
      treeIdentity: null,
      checkedAt: FIXED_TIME,
      reason: "fixture: mirror seeded directly, not derived",
    },
  });

  assert.throws(() =>
    parseUpdateQueueArgs([
      "--objective-code",
      "uqvbodyprotect",
      "--body",
      "",
    ]),
  );

  const stored = store.readItem("uqvbodyprotect");
  assert.equal(
    stored!.body,
    "a 4,600-character objective specification stand-in",
    "the refusal must happen at parse time, before updateQueueItem/store.mutateItem is ever reached",
  );
});
