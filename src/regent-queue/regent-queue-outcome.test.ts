import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  openRegentQueueStore,
  RegentQueueItemStatus,
} from "./regent-queue.store.ts";
import { renderRegentQueueAsMarkdown } from "./regent-queue-render.ts";
import { QueueOutcome } from "./regent-queue-outcome.ts";
import { withTempDir } from "./regent-queue.store.test-support.ts";

const OUTCOME_COLUMN_NAMES = [
  "outcome",
  "outcome_summary",
  "pr_url",
  "result_commit",
  "completed_at",
];

function lineFor(markdown: string, objectiveCode: string): string {
  return (
    markdown.split("\n").find((line) => line.includes(`**${objectiveCode}**`)) ??
    ""
  );
}

test("opening a queue database from before the outcome record adds the outcome columns and leaves old rows not recorded", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "queue.sqlite3");
    const first = openRegentQueueStore(file);
    const finished = first.insertItem({ objectiveCode: "finished", body: "INTENT: landed earlier" });
    first.mutateItem(finished.id, { status: RegentQueueItemStatus.Complete });
    first.insertItem({ objectiveCode: "waiting", body: "INTENT: still open" });
    first.close();
    const legacy = new DatabaseSync(file);
    for (const column of OUTCOME_COLUMN_NAMES)
      legacy.exec(`ALTER TABLE queue_items DROP COLUMN ${column}`);
    legacy.close();

    const reopened = openRegentQueueStore(file);
    const survivor = reopened.readItem(finished.id);
    const markdown = renderRegentQueueAsMarkdown(reopened.readAll());
    reopened.close();

    assert.ok(survivor);
    assert.equal(survivor.status, RegentQueueItemStatus.Complete);
    assert.equal(survivor.outcome, null);
    assert.equal(survivor.outcomeSummary, null);
    assert.equal(survivor.prUrl, null);
    assert.equal(survivor.resultCommit, null);
    assert.equal(survivor.completedAt, null);
    assert.match(lineFor(markdown, "finished"), /outcome: not recorded/);
    assert.doesNotMatch(lineFor(markdown, "waiting"), /outcome:/);
    const inspect = new DatabaseSync(file);
    const columnNames = (
      inspect.prepare("PRAGMA table_info(queue_items)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    inspect.close();
    for (const column of OUTCOME_COLUMN_NAMES)
      assert.equal(columnNames.filter((name) => name === column).length, 1, column);
  });
});

test("render-queue shows not recorded for a finished row with no outcome", () => {
  withTempDir((dir) => {
    const store = openRegentQueueStore(path.join(dir, "queue.sqlite3"));
    const given = store.insertItem({ objectiveCode: "givenup", body: "INTENT: dropped" });
    store.mutateItem(given.id, { status: RegentQueueItemStatus.Abandoned });
    store.insertItem({ objectiveCode: "flying", body: "INTENT: under way" });
    const markdown = renderRegentQueueAsMarkdown(store.readAll());
    store.close();

    assert.match(lineFor(markdown, "givenup"), /outcome: not recorded/);
    assert.doesNotMatch(lineFor(markdown, "flying"), /outcome:/);
  });
});

test("render-queue shows a finished row's outcome, summary, pull request, result commit and completion time", () => {
  withTempDir((dir) => {
    const completedAt = Date.parse("2026-10-07T09:30:00.000Z");
    const store = openRegentQueueStore(path.join(dir, "queue.sqlite3"), () => completedAt);
    const landed = store.insertItem({ objectiveCode: "landed", body: "INTENT: ship it" });
    store.mutateItem(landed.id, {
      status: RegentQueueItemStatus.Complete,
      outcome: QueueOutcome.Merged,
      outcomeSummary: "The change was squash-merged after review.",
      prUrl: "https://github.com/example/project/pull/42",
      resultCommit: "4b1d2c3",
    });
    const markdown = renderRegentQueueAsMarkdown(store.readAll());
    store.close();

    const line = lineFor(markdown, "landed");
    assert.match(line, /outcome: merged/);
    assert.match(line, /summary: The change was squash-merged after review\./);
    assert.match(line, /pull request: https:\/\/github\.com\/example\/project\/pull\/42/);
    assert.match(line, /result commit: 4b1d2c3/);
    assert.match(line, /completed: 2026-10-07T09:30:00\.000Z/);
    assert.doesNotMatch(line, /not recorded/);
  });
});

test("a row records when it completed the moment it becomes complete or abandoned", () => {
  withTempDir((dir) => {
    let clock = 1_000;
    const store = openRegentQueueStore(path.join(dir, "queue.sqlite3"), () => clock);
    const finishing = store.insertItem({ objectiveCode: "finishing", body: "INTENT: finish" });
    const dropping = store.insertItem({ objectiveCode: "dropping", body: "INTENT: drop" });

    clock = 2_000;
    const flying = store.mutateItem(finishing.id, { status: RegentQueueItemStatus.InFlight });
    assert.equal(flying.completedAt, null);

    clock = 3_000;
    const completed = store.mutateItem(finishing.id, { status: RegentQueueItemStatus.Complete });
    assert.equal(completed.completedAt, 3_000);

    clock = 4_000;
    const laterEdit = store.mutateItem(finishing.id, { outcome: QueueOutcome.Delivered });
    assert.equal(laterEdit.completedAt, 3_000);

    clock = 5_000;
    const abandoned = store.mutateItem(dropping.id, { status: RegentQueueItemStatus.Abandoned });
    assert.equal(abandoned.completedAt, 5_000);

    clock = 6_000;
    const reopened = store.mutateItem(dropping.id, { status: RegentQueueItemStatus.Open });
    assert.equal(reopened.completedAt, null);
    store.close();
  });
});

test("a queue row cannot be given an outcome outside delivered, merged, refused, blocked and abandoned", () => {
  withTempDir((dir) => {
    const store = openRegentQueueStore(path.join(dir, "queue.sqlite3"));
    const row = store.insertItem({ objectiveCode: "checked", body: "INTENT: check outcomes" });

    assert.throws(
      () =>
        store.mutateItem(row.id, {
          status: RegentQueueItemStatus.Complete,
          outcome: "succeeded" as QueueOutcome,
        }),
      /queue outcome "succeeded" is invalid/,
    );
    const untouched = store.readItem(row.id);
    assert.equal(untouched?.status, RegentQueueItemStatus.Open);
    assert.equal(untouched?.outcome, null);

    for (const outcome of Object.values(QueueOutcome))
      assert.equal(store.mutateItem(row.id, { outcome }).outcome, outcome);
    store.close();
  });
});
