import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openRegentQueueStore } from "./regent-queue.store.ts";
import { withTempDir } from "./regent-queue.store.test-support.ts";

test("a single-slice queue row survives insert and read-back, and an ordinary row is not single-slice", () => {
  withTempDir((dir) => {
    const store = openRegentQueueStore(path.join(dir, "queue.sqlite3"));
    const inserted = store.insertItem({
      objectiveCode: "one",
      body: "INTENT: one slice",
      singleSlice: true,
    });
    assert.equal(inserted.singleSlice, true);
    assert.equal(store.readItem(inserted.id)?.singleSlice, true);
    const ordinary = store.insertItem({ objectiveCode: "ord", body: "INTENT: ordinary campaign" });
    assert.equal(ordinary.singleSlice, false);
    store.close();
  });
});

test("an old row stored as shadowless or sliceless still reads and is an ordinary campaign", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "queue.sqlite3");
    const first = openRegentQueueStore(file);
    const filedEarlier = first.insertItem({ objectiveCode: "old", body: "INTENT: filed earlier" });
    first.close();
    const legacy = new DatabaseSync(file);
    legacy.prepare("UPDATE queue_items SET shadowless = 1, sliceless = 1 WHERE id = ?").run(filedEarlier.id);
    legacy.close();
    const reopened = openRegentQueueStore(file);
    const survivor = reopened.readItem(filedEarlier.id);
    assert.ok(survivor);
    assert.equal(survivor.singleSlice, false);
    assert.equal("shadowless" in survivor, false);
    assert.equal("sliceless" in survivor, false);
    reopened.close();
  });
});

test("opening a queue database created before the single-slice column existed adds the column without touching its rows", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "queue.sqlite3");
    const first = openRegentQueueStore(file);
    const filedEarlier = first.insertItem({ objectiveCode: "old", body: "INTENT: filed earlier" });
    first.close();
    const legacy = new DatabaseSync(file);
    legacy.exec("ALTER TABLE queue_items DROP COLUMN single_slice");
    legacy.close();
    const reopened = openRegentQueueStore(file);
    const survivor = reopened.readItem(filedEarlier.id);
    assert.ok(survivor);
    assert.equal(survivor.body, "INTENT: filed earlier");
    assert.equal(survivor.singleSlice, false);
    reopened.close();
  });
});
