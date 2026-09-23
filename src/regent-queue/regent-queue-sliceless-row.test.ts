import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openRegentQueueStore } from "./regent-queue.store.ts";
import { withTempDir } from "./regent-queue.store.test-support.ts";

test("a sliceless queue row is stored with both the sliceless and the shadowless flag and reads back that way", () => {
  withTempDir((dir) => {
    const store = openRegentQueueStore(path.join(dir, "queue.sqlite3"));
    const inserted = store.insertItem({
      objectiveCode: "slc",
      body: "INTENT: fix one function",
      sliceless: true,
      shadowless: true,
    });
    assert.equal(inserted.sliceless, true);
    assert.equal(inserted.shadowless, true);
    const ordinary = store.insertItem({
      objectiveCode: "ord",
      body: "INTENT: ordinary campaign",
    });
    assert.equal(ordinary.sliceless, false);
    assert.equal(ordinary.shadowless, false);
    store.close();
  });
});

test("opening a queue database created before the sliceless column existed adds the column without touching its rows", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "queue.sqlite3");
    const first = openRegentQueueStore(file);
    const filedEarlier = first.insertItem({ objectiveCode: "old", body: "INTENT: filed earlier" });
    first.close();
    const legacy = new DatabaseSync(file);
    legacy.exec("ALTER TABLE queue_items DROP COLUMN sliceless");
    legacy.close();
    const reopened = openRegentQueueStore(file);
    const survivor = reopened.readItem(filedEarlier.id);
    assert.ok(survivor);
    assert.equal(survivor.body, "INTENT: filed earlier");
    assert.equal(survivor.sliceless, false);
    reopened.close();
  });
});
