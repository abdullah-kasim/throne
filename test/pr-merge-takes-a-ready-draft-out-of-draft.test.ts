import { test } from "node:test";
import assert from "node:assert/strict";
import { missingPhrases, readBullet, readMarkdownSection, readSkill, readSkillSource, unwrap } from "./skill-contract-test-helpers.ts";

test("/pr-merge marks a draft root ready for review only after every Ready condition holds", async () => {
  const ready = readBullet(await readSkill("pr-merge"), "Ready");
  const conditions = "Once Prove has passed, the repromote has succeeded, that check exits 0 and CI is green on the final head, and only then, a draft root leaves draft on both forges";
  assert.deepEqual(missingPhrases(ready, [conditions, "`<gh> pr view <root> --json isDraft`", "`<gh> --bypass pr ready <root>`"]), []);
  assert.ok(ready.indexOf("`throne forge check-media-links <root url>` exits 0") < ready.indexOf(conditions));
  assert.ok(ready.indexOf(conditions) < ready.indexOf("`<gh> --bypass pr ready <root>`"));
});

test("/pr-merge reads the draft state back on GitHub after marking it ready", async () => {
  assert.deepEqual(missingPhrases(readBullet(await readSkill("pr-merge"), "Ready"), [
    "with `--bypass` right after the program name because the throne gh guard reads it only there, then read it back with the same `pr view` and confirm `isDraft` is false.",
  ]), []);
});

test("/pr-merge drops the Forgejo twin's WIP prefix and keeps its GitHub marker", async () => {
  assert.deepEqual(missingPhrases(readBullet(await readSkill("pr-merge"), "Ready"), [
    "read it with `throne forge pr view <twin url>`; a Forgejo draft is a title that starts with `WIP: `",
    "set that printed title, its `[GH-<n>]` marker and the rest kept exactly, with `throne forge pr edit <twin url> --title \"<title>\"`",
    "confirm `isDraft` is false and the marker is still there.",
  ]), []);
});

test("/pr-merge takes a ready draft out of draft with and without a merge order", async () => {
  assert.deepEqual(missingPhrases(readBullet(await readSkill("pr-merge"), "Ready"), [
    "A merge-ordered row passes through this step too, on its way to **Merge**.",
    "Without an explicit merge order in the RULINGS, the row ends here: the root stays open, ready for merge and out of draft",
  ]), []);
});

test("REPORT.md says the root was moved out of draft or was already ready", async () => {
  assert.deepEqual(missingPhrases(readBullet(await readSkill("pr-merge"), "Ready"), [
    'REPORT.md records "moved out of draft" with the forges it changed, or says the root was already ready.',
  ]), []);
});

test("the Lord's /pr-merge order authorizes pr ready with --bypass on the root only", async () => {
  assert.deepEqual(missingPhrases(readBullet(await readSkill("pr-merge"), "Ready"), [
    "That is the one GitHub write this step makes, on the root only, and the Lord's /pr-merge order authorizes it with or without a merge order.",
  ]), []);
  assert.deepEqual(missingPhrases(readBullet(await readSkill("pr-merge"), "Merge"), [
    "the Lord's /pr-merge order, with or without a merge order, authorizes `--bypass` on `pr ready` on the root only (in **Ready**)",
    "and nothing else: no review, no review request, no label, no body edit.",
  ]), []);
});

test("the worked shape ends with the root out of draft", async () => {
  const workedShape = unwrap(readMarkdownSection(await readSkillSource("pr-merge"), "## Worked shape"));
  assert.ok(workedShape.trimEnd().endsWith("with the root open, ready for merge and out of draft."));
});
