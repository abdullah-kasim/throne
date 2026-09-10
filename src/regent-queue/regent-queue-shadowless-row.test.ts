import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { openRegentQueueStore } from "./regent-queue.store.ts";
import { withTempDir } from "./regent-queue.store.test-support.ts";

test("a shadowless queue row survives insert and read-back as a boolean", () => {
  withTempDir((dir) => {
    const store = openRegentQueueStore(path.join(dir, "queue.sqlite3"));
    const inserted = store.insertItem({
      objectiveCode: "shl",
      body: "INTENT: run without shadows",
      shadowless: true,
    });
    assert.equal(inserted.shadowless, true);
    const ordinary = store.insertItem({
      objectiveCode: "ord",
      body: "INTENT: ordinary campaign",
    });
    assert.equal(ordinary.shadowless, false);
    store.close();
  });
});
