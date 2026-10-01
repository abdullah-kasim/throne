import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openRegentQueueStore } from "./regent-queue.store.ts";
import { renderRegentQueueAsMarkdown } from "./regent-queue-render.ts";
import { withTempDir } from "./regent-queue.store.test-support.ts";

test("the queue schema upgrade adds the effort column once and existing rows read back with no effort", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "queue.sqlite3");
    const first = openRegentQueueStore(file);
    const filedEarlier = first.insertItem({ objectiveCode: "old", body: "INTENT: filed earlier" });
    first.close();
    const legacy = new DatabaseSync(file);
    legacy.exec("ALTER TABLE queue_items DROP COLUMN effort");
    legacy.close();
    openRegentQueueStore(file).close();
    const reopened = openRegentQueueStore(file);
    const survivor = reopened.readItem(filedEarlier.id);
    assert.ok(survivor);
    assert.equal(survivor.body, "INTENT: filed earlier");
    assert.equal(survivor.effort, null);
    reopened.close();
    const inspect = new DatabaseSync(file);
    const effortColumns = (inspect.prepare("PRAGMA table_info(queue_items)").all() as Array<{ name: string }>)
      .filter((column) => column.name === "effort");
    inspect.close();
    assert.equal(effortColumns.length, 1);
  });
});

test("render-queue shows a row's effort", () => {
  withTempDir((dir) => {
    const store = openRegentQueueStore(path.join(dir, "queue.sqlite3"));
    const stored = store.insertItem({ objectiveCode: "hard", body: "INTENT: hard work", effort: 3 });
    assert.equal(stored.effort, 3);
    store.insertItem({ objectiveCode: "plain", body: "INTENT: plain work" });
    const markdown = renderRegentQueueAsMarkdown(store.readAll());
    store.close();
    const hardLine = markdown.split("\n").find((line) => line.includes("**hard**"));
    const plainLine = markdown.split("\n").find((line) => line.includes("**plain**"));
    assert.match(hardLine ?? "", /effort: 3 \(high\)/);
    assert.doesNotMatch(plainLine ?? "", /effort/);
  });
});
