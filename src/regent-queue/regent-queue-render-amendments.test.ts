import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { openRegentQueueStore } from "./regent-queue.store.ts";
import { openRegentQueueAmendments } from "./regent-queue-amendments.ts";
import { renderRegentQueueAsMarkdown } from "./regent-queue-render.ts";
import { withTempDir } from "./regent-queue.store.test-support.ts";

test("render-queue prints each recorded amendment under its row's body, in number order, with its provenance", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "queue.sqlite3");
    const store = openRegentQueueStore(file);
    store.insertItem({ objectiveCode: "amended", body: "INTENT: the original body" });
    store.insertItem({ objectiveCode: "untouched", body: "INTENT: nothing added" });
    const amendments = openRegentQueueAmendments(file);
    amendments.record({ objectiveCode: "amended", text: "first change", wordsOf: "Lord", relayedBy: "stager-one" });
    amendments.record({ objectiveCode: "amended", text: "second change", wordsOf: "Lord", relayedBy: "Regent" });
    const markdown = renderRegentQueueAsMarkdown(store.readAll(), {}, amendments.readAllByObjective());
    amendments.close();
    store.close();

    const amendedSection = markdown.slice(markdown.indexOf("**amended**"), markdown.indexOf("**untouched**") === -1 ? undefined : markdown.indexOf("**untouched**"));
    const bodyAt = markdown.indexOf("INTENT: the original body");
    const firstAt = markdown.indexOf("AMENDMENT 1 (words of Lord, relayed by stager-one, recorded while open):\n\nfirst change");
    const secondAt = markdown.indexOf("AMENDMENT 2 (words of Lord, relayed by Regent, recorded while open):\n\nsecond change");
    assert.ok(bodyAt >= 0 && firstAt > bodyAt && secondAt > firstAt, markdown);
    assert.ok(amendedSection.length > 0);
    const untouchedSection = markdown.slice(markdown.indexOf("**untouched**"));
    assert.equal(untouchedSection.includes("AMENDMENT"), false, markdown);
  });
});

test("a caller that passes no amendments renders rows exactly as before", () => {
  withTempDir((dir) => {
    const store = openRegentQueueStore(path.join(dir, "queue.sqlite3"));
    store.insertItem({ objectiveCode: "plain", body: "INTENT: plain" });
    const markdown = renderRegentQueueAsMarkdown(store.readAll());
    store.close();
    assert.equal(markdown.includes("AMENDMENT"), false);
    assert.ok(markdown.endsWith("INTENT: plain\n"), markdown);
  });
});
