import { test } from "node:test";
import assert from "node:assert/strict";
import { missingPhrases, readBullet, readSkill } from "./skill-contract-test-helpers.ts";

async function readStep(step: string): Promise<string> {
  return readBullet(await readSkill("pr-merge"), step);
}

function assertSaysAll(text: string, phrases: string[]): void {
  assert.deepEqual(missingPhrases(text, phrases), []);
}

test("a merge-ordered /pr-merge answers automated review findings in an Answer step between Ready and Merge", async () => {
  const skill = await readSkill("pr-merge");
  const readyAt = skill.indexOf("- **Ready**");
  const answerAt = skill.indexOf("- **Answer**");
  const mergeAt = skill.indexOf("- **Merge**");
  assert.ok(readyAt !== -1 && readyAt < answerAt && answerAt < mergeAt, "Answer sits after Ready and before Merge");
  assert.ok((await readStep("Answer")).startsWith("- **Answer**: runs only when the RULINGS quote an explicit merge order, after **Ready** and before **Merge**."));
  assert.ok((await readStep("Merge")).includes("it comes after every ready step above and after **Answer**."));
});

test("a fix through Fail goes back through Answer before the merge", async () => {
  assertSaysAll(await readStep("Fail"), [
    "then go on to **Ready** and, on an explicit merge order, **Answer** and **Merge**.",
  ]);
});

test("the Answer step reads only automated reviewers' reviews and comments, detected by the account type GitHub reports", async () => {
  assertSaysAll(await readStep("Answer"), [
    "Then read every review, review comment and conversation comment on the root",
    "`<gh> api repos/<o>/<r>/issues/<n>/comments`",
    "`<gh> api repos/<o>/<r>/pulls/<n>/comments`",
    "`<gh> api repos/<o>/<r>/pulls/<n>/reviews`",
    'keep only those by automated reviewers, the accounts GitHub reports with `user.type == "Bot"` or a login ending in `[bot]`',
    "that are about the head being merged or were posted after it was pushed",
  ]);
});

test("the Answer step waits a bounded time for an automated reviewer that runs on every push and has not reviewed the final head", async () => {
  assertSaysAll(await readStep("Answer"), [
    "An automated reviewer known to run on every push, because it reviewed an earlier push of this pull request or an operator's private extension of this skill names it",
    "that has not yet reviewed the final head is waited for with a Monitor until-loop, as **Update** waits for CI, bounded at 30 minutes by default; if it never arrives, REPORT.md says so.",
  ]);
});

test("each automated finding is fixed through Update and Fail or answered with its evidence, and never merged over unanswered", async () => {
  assertSaysAll(await readStep("Answer"), [
    "Each automated finding is then either fixed or answered.",
    "A fix goes in its own commit through **Update** and **Fail**, exactly as a red check does, and the reviews are read again for the new head.",
    "when the finding is rejected, carries the evidence: which test, which engines, what was observed.",
    "When the reviewer documents its own reply form, the answer uses that form; an operator's private extension of this skill may supply those forms.",
    "Never merge over an automated finding that has neither a fix nor an answer.",
  ]);
});

test("REPORT.md lists every automated finding on the final head with its fate, and people's comments with their URLs", async () => {
  assertSaysAll(await readStep("Answer"), [
    "REPORT.md carries a table of every automated finding on the final head with its fate (fixed: the commit; answered: the comment URL), and lists people's comments on the final head with their URLs, unanswered.",
  ]);
});

test("without a merge order the row ends at Ready and answers nothing", async () => {
  assertSaysAll(await readStep("Ready"), [
    "Without an explicit merge order in the RULINGS, the row ends here",
    "It answers nothing: it reads the root's reviews and comments as **Answer** does, and lists the automated findings and people's comments on the final head in REPORT.md for the Lord.",
  ]);
});

test("a person's review or comment is never answered by the Answer step", async () => {
  assertSaysAll(await readStep("Answer"), [
    "A person's review or comment is never answered or acted on by this step.",
    "A person's comment from before the launch does not stop the merge; it is only listed.",
  ]);
});

test("a person's comment posted after the row launched stops the merge, checked at the start of Answer and again immediately before the merge command", async () => {
  assertSaysAll(await readStep("Answer"), [
    "It opens with the person check: a review, review comment or conversation comment on the root by a person, created after the row launched, stops the merge (**Stop**).",
    "A person is any account GitHub does not report as automated, the operator's own account included.",
    "The window is the whole run, from the row launching until the merge command runs: the check runs again immediately before the merge command in **Merge**, and that last check closes the window",
  ]);
  assertSaysAll(await readStep("Merge"), [
    "Immediately before the merge command, run the person check from **Answer** again; a hit is a **Stop**.",
  ]);
});

test("the row's own comments, matched by the ids it recorded, never stop the merge", async () => {
  assertSaysAll(await readStep("Answer"), [
    "The row's own posts never count; they are matched by the comment ids the row recorded when posting them, not by author.",
    "from its first step the row keeps its launch time and the id of every comment it posts in the Alpha's data directory.",
  ]);
});

test("a stop for a person's comment merges nothing, pushes nothing, replies to no one and is reported for the Lord", async () => {
  assertSaysAll(await readStep("Stop"), [
    "a person's review or comment on the root posted after the row launched, found by the person check in **Answer**",
    "A person's comment gets no comment at all: the row merges nothing, pushes nothing further, replies to no one, and marks the campaign complete",
    'REPORT.md saying "not merged: a person commented during the merge" and giving each comment\'s URL, author, time and first lines',
    "the supervisor is told, so the Regent tells the Lord. The Lord decides; the row never asks him, and the Stager files any follow-up on his word.",
  ]);
});

test("the merge order allows comment replies to automated review findings on the root and still no review, review request, label or body edit", async () => {
  const merge = await readStep("Merge");
  assertSaysAll(merge, [
    "the last only for the refusal comments this skill prescribes at a **Stop** and for replies to automated review findings on the root, and nothing else: no review, no review request, no label, no body edit.",
  ]);
  assert.ok(!merge.includes("no other comment"));
});
