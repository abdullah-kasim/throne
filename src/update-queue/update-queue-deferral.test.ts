import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { RegentQueueItemStatus } from "../regent-queue/regent-queue-item-state.ts";
import { findQueueItemByObjectiveCode } from "../regent-queue/regent-queue-lifecycle.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import { parseUpdateQueueArgs, updateQueueItem } from "./update-queue-runtime.ts";

const scratchDirectory = await mkdtemp(path.join(tmpdir(), "update-queue-deferral-"));
after(() => rm(scratchDirectory, { recursive: true, force: true }));

function deferArguments(code: string, ...flags: string[]): string[] {
  return ["--objective-code", code, "--status", "deferred", ...flags];
}

test("deferring a row requires the objectives it waits on and a reason", () => {
  assert.throws(
    () => parseUpdateQueueArgs(deferArguments("upper", "--defer-reason", "waits for lower")),
    /--status deferred requires --depends-on .* and --defer-reason/,
  );
  assert.throws(
    () => parseUpdateQueueArgs(deferArguments("upper", "--depends-on", "lower")),
    /--status deferred requires --depends-on .* and --defer-reason/,
  );
  assert.throws(
    () => parseUpdateQueueArgs(["--objective-code", "upper", "--depends-on", "lower", "--defer-reason", "x"]),
    /require --status deferred/,
  );
  const input = parseUpdateQueueArgs(
    deferArguments("upper", "--depends-on", "lower, middle ", "--defer-reason", "waits for lower"),
  );
  assert.deepEqual(input.mutation.deferral, { dependsOn: ["lower", "middle"], reason: "waits for lower" });
});

test("update-queue refuses an argument it does not know", () => {
  assert.throws(
    () =>
      parseUpdateQueueArgs(
        deferArguments("upper", "--depends-on", "lower", "--defer-reason", "x", "--released-by", "Regent"),
      ),
    /unknown argument "--released-by"/,
  );
});

test("a deferred row cannot be reopened through update-queue", () => {
  const store = openRegentQueueStore(path.join(scratchDirectory, "reopen.sqlite3"));
  try {
    store.insertItem({ objectiveCode: "upper", body: "INTENT: upper" });
    store.insertItem({ objectiveCode: "spare", body: "INTENT: spare" });
    for (const code of ["upper", "spare"])
      updateQueueItem(store, parseUpdateQueueArgs(deferArguments(code, "--depends-on", "lower", "--defer-reason", "x")));
    assert.throws(
      () => updateQueueItem(store, parseUpdateQueueArgs(["--objective-code", "upper", "--status", "open"])),
      /"upper" is deferred; only release-deferred moves it to open/,
    );
    assert.equal(findQueueItemByObjectiveCode(store, "upper")?.status, RegentQueueItemStatus.Deferred);
    updateQueueItem(store, parseUpdateQueueArgs(["--objective-code", "spare", "--status", "abandoned"]));
    assert.equal(findQueueItemByObjectiveCode(store, "spare")?.status, RegentQueueItemStatus.Abandoned);
  } finally {
    store.close();
  }
});

test("a deferred row records when it was deferred", () => {
  let clock = 1_000;
  const store = openRegentQueueStore(path.join(scratchDirectory, "deferred-at.sqlite3"), () => clock);
  try {
    store.insertItem({ objectiveCode: "upper", body: "INTENT: upper" });
    clock = 5_000;
    updateQueueItem(store, parseUpdateQueueArgs(deferArguments("upper", "--depends-on", "lower", "--defer-reason", "x")));
    clock = 9_000;
    updateQueueItem(
      store,
      parseUpdateQueueArgs(deferArguments("upper", "--depends-on", "lower,middle", "--defer-reason", "y")),
    );
    assert.equal(findQueueItemByObjectiveCode(store, "upper")?.deferral?.deferredAt, 5_000);
    updateQueueItem(store, parseUpdateQueueArgs(["--objective-code", "upper", "--status", "abandoned"]));
    assert.equal(findQueueItemByObjectiveCode(store, "upper")?.deferral, null);
  } finally {
    store.close();
  }
});
