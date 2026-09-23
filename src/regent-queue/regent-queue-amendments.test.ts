import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { openRegentQueueStore } from "./regent-queue.store.ts";
import { openRegentQueueAmendments } from "./regent-queue-amendments.ts";
import { withTempDir } from "./regent-queue.store.test-support.ts";

function fileRow(file: string, objectiveCode: string): void {
  const store = openRegentQueueStore(file);
  store.insertItem({ objectiveCode, body: `INTENT: ${objectiveCode}` });
  store.close();
}

test("amendments on one queue row are numbered 1, 2, 3 in the order they are recorded", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "queue.sqlite3");
    fileRow(file, "alpha1");
    let clock = 1_000;
    const amendments = openRegentQueueAmendments(file, () => clock++);
    const first = amendments.record({ objectiveCode: "alpha1", text: "rename it", wordsOf: "Lord", relayedBy: "stager-one" });
    const second = amendments.record({ objectiveCode: "alpha1", text: "no retries on 429", wordsOf: "Lord", relayedBy: "Regent" });
    assert.equal(first.number, 1);
    assert.equal(second.number, 2);
    assert.deepEqual(
      amendments.readForObjective("alpha1").map((amendment) => [amendment.number, amendment.text, amendment.wordsOf, amendment.relayedBy]),
      [
        [1, "rename it", "Lord", "stager-one"],
        [2, "no retries on 429", "Lord", "Regent"],
      ],
    );
    assert.equal(amendments.highestNumberFor("alpha1"), 2);
    amendments.close();
  });
});

test("each queue row numbers its own amendments independently", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "queue.sqlite3");
    fileRow(file, "first");
    fileRow(file, "second");
    const amendments = openRegentQueueAmendments(file);
    amendments.record({ objectiveCode: "first", text: "a", wordsOf: "Lord", relayedBy: "s" });
    amendments.record({ objectiveCode: "first", text: "b", wordsOf: "Lord", relayedBy: "s" });
    const onSecond = amendments.record({ objectiveCode: "second", text: "c", wordsOf: "Lord", relayedBy: "s" });
    assert.equal(onSecond.number, 1);
    assert.equal(amendments.highestNumberFor("first"), 2);
    assert.equal(amendments.highestNumberFor("second"), 1);
    assert.deepEqual([...amendments.readAllByObjective().keys()], ["first", "second"]);
    amendments.close();
  });
});

test("an amendment remembers the row status it was recorded against", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "queue.sqlite3");
    fileRow(file, "flying");
    const store = openRegentQueueStore(file);
    const row = store.readAll();
    assert.equal(row.state, "items");
    const id = row.state === "items" ? row.items[0]!.id : "";
    store.mutateItem(id, { status: "in-flight", agentName: "alpha-flying-01", targetRepo: dir, baseCommit: "abc" });
    store.close();
    const amendments = openRegentQueueAmendments(file);
    const recorded = amendments.record({ objectiveCode: "flying", text: "x", wordsOf: "Lord", relayedBy: "s" });
    assert.equal(recorded.rowStatusWhenRecorded, "in-flight");
    amendments.close();
  });
});

test("recording against a code that has no queue row refuses and records nothing", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "queue.sqlite3");
    fileRow(file, "real");
    const amendments = openRegentQueueAmendments(file);
    assert.throws(
      () => amendments.record({ objectiveCode: "ghost", text: "x", wordsOf: "Lord", relayedBy: "s" }),
      /queue objective "ghost" does not exist/,
    );
    assert.equal(amendments.highestNumberFor("ghost"), 0);
    assert.deepEqual(amendments.readForObjective("ghost"), []);
    assert.equal(amendments.readAllByObjective().size, 0);
    amendments.close();
  });
});

test("a row with no amendments reports zero and an empty list", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "queue.sqlite3");
    fileRow(file, "quiet");
    const amendments = openRegentQueueAmendments(file);
    assert.equal(amendments.highestNumberFor("quiet"), 0);
    assert.deepEqual(amendments.readForObjective("quiet"), []);
    amendments.close();
  });
});
