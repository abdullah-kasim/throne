import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import { withTempDir } from "../regent-queue/regent-queue.store.test-support.ts";
import { parseUpdateQueueArgs, updateQueueItem } from "./update-queue-runtime.ts";

test("the row's filer can set and clear the effort of a queued row", () => {
  withTempDir((dir) => {
    const store = openRegentQueueStore(path.join(dir, "queue.sqlite3"));
    store.insertItem({ objectiveCode: "eff", body: "INTENT: work" });
    const raised = updateQueueItem(store, parseUpdateQueueArgs(["--objective-code", "eff", "--effort", "xhigh"]));
    assert.equal(raised.effort, 4);
    const renumbered = updateQueueItem(store, parseUpdateQueueArgs(["--objective-code", "eff", "--effort", "2"]));
    assert.equal(renumbered.effort, 2);
    const untouched = updateQueueItem(store, parseUpdateQueueArgs(["--objective-code", "eff", "--priority", "2"]));
    assert.equal(untouched.effort, 2);
    const cleared = updateQueueItem(store, parseUpdateQueueArgs(["--objective-code", "eff", "--clear-effort"]));
    assert.equal(cleared.effort, null);
    store.close();
  });
  assert.throws(
    () => parseUpdateQueueArgs(["--objective-code", "eff", "--effort", "9"]),
    /is not an effort/,
  );
  assert.throws(
    () => parseUpdateQueueArgs(["--objective-code", "eff", "--effort", "high", "--clear-effort"]),
    /pass one of --effort or --clear-effort, once/,
  );
});
