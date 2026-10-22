import { test } from "node:test";
import assert from "node:assert/strict";
import { missingPhrases, readMarkdownSection, readSkillSource, unwrap } from "./skill-contract-test-helpers.ts";

async function readRepromote(): Promise<string> {
  return unwrap(readMarkdownSection(await readSkillSource("pr-promote"), "## 2. Repromote"));
}

test("a repromote answers the automated review findings before it runs the command", async () => {
  const repromote = await readRepromote();
  const answerAt = repromote.indexOf("**Answer the automated reviews first.**");
  const commandAt = repromote.indexOf("The same command on a pull request that is already promoted");
  assert.ok(answerAt !== -1 && answerAt < commandAt, "the answer paragraph opens the Repromote section");
  assert.deepEqual(
    missingPhrases(repromote, [
      "Before a repromote runs the command, settle every finding an automated reviewer left on the GitHub pull request",
      'keep only those by automated reviewers, the accounts GitHub reports with `user.type == "Bot"` or a login ending in `[bot]`',
      "A finding counts unless a later review lists it as resolved, it was already answered on GitHub, or it was mirrored into Forgejo and answered there",
      "Judge each one against the code and the evidence, then either fix it on the Forgejo branch in its own commit, which the repromote pushes, or answer it",
      "when it is rejected, carries the evidence: which test, which engines, what was observed.",
      "The Lord's word to repromote authorizes `--bypass` on that `pr comment`, and nothing else.",
      "Never repromote while a finding has neither a fix nor an answer.",
      "A person's review or comment is never answered here.",
      "A first promote skips this: GitHub has no reviews yet.",
    ]),
    [],
  );
});
