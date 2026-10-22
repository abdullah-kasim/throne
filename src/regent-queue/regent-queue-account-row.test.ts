import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openRegentQueueStore } from "./regent-queue.store.ts";
import { renderRegentQueueAsMarkdown } from "./regent-queue-render.ts";
import { withTempDir } from "./regent-queue.store.test-support.ts";

test("a row's company account is read from its body and render-queue shows it as a launch fact", () => {
  withTempDir((dir) => {
    const store = openRegentQueueStore(path.join(dir, "queue.sqlite3"));
    const company = store.insertItem({ objectiveCode: "work", body: "INTENT: work\nACCOUNT: company" });
    store.insertItem({ objectiveCode: "plain", body: "INTENT: plain work" });
    assert.equal(company.account, "company");
    const markdown = renderRegentQueueAsMarkdown(store.readAll());
    store.close();
    const workLine = markdown.split("\n").find((line) => line.includes("**work**"));
    const plainLine = markdown.split("\n").find((line) => line.includes("**plain**"));
    assert.match(workLine ?? "", /account: company/);
    assert.doesNotMatch(plainLine ?? "", /account:/);
  });
});

test("editing a row's body adds or drops its company account with the ACCOUNT line", () => {
  withTempDir((dir) => {
    const store = openRegentQueueStore(path.join(dir, "queue.sqlite3"));
    const row = store.insertItem({ objectiveCode: "edit", body: "INTENT: edit" });
    assert.equal(row.account, null);
    assert.equal(store.mutateItem(row.id, { body: "INTENT: edit\nACCOUNT: company" }).account, "company");
    assert.equal(store.mutateItem(row.id, { priority: 2 }).account, "company");
    assert.equal(store.mutateItem(row.id, { body: "INTENT: edit" }).account, null);
    store.close();
  });
});

test("the queue schema upgrade adds the account column once and existing rows read back with no account", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "queue.sqlite3");
    const first = openRegentQueueStore(file);
    const filedEarlier = first.insertItem({ objectiveCode: "old", body: "INTENT: filed earlier" });
    first.close();
    const legacy = new DatabaseSync(file);
    legacy.exec("ALTER TABLE queue_items DROP COLUMN account");
    legacy.close();
    openRegentQueueStore(file).close();
    const reopened = openRegentQueueStore(file);
    assert.equal(reopened.readItem(filedEarlier.id)?.account, null);
    reopened.close();
    const inspect = new DatabaseSync(file);
    const accountColumns = (inspect.prepare("PRAGMA table_info(queue_items)").all() as Array<{ name: string }>)
      .filter((column) => column.name === "account");
    inspect.close();
    assert.equal(accountColumns.length, 1);
  });
});
