import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { missingPhrases, readMarkdownSection } from "./skill-contract-test-helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

async function readPullRequestDelivery(): Promise<string> {
  const skill = await readFile(path.join(ROOT, ".claude/skills/execute-todos/SKILL.md"), "utf8");
  const section = readMarkdownSection(skill, "#### Pull-request delivery — when the deliverable is a PR, not a merge");
  assert.notEqual(section, "", "execute-todos has no Pull-request delivery section");
  return section.replace(/\s*\n\s*/g, " ");
}

test("a pull request that names a parent opens against the parent's branch and takes its updates by merge", async () => {
  const delivery = await readPullRequestDelivery();
  assert.deepEqual(
    missingPhrases(delivery, [
      "A row naming a parent PR delivers onto its own branch, which starts from the parent's branch",
      "`/pr-split`'s execution contract",
      "the PR opens with `--base <parent-branch>`",
      "Parent updates come into the branch by merge, never by rebase or force push.",
      "retarget its base to the parent's branch before the first push",
      "A row with no parent PR branches from the default branch and opens against it.",
      "A stack lands through `/pr-merge`.",
      "or from the parent PR's branch for a stacked row",
      "--base <default branch or parent-branch>",
    ]),
    [],
  );
});

test("a stacked pull request body says which pull request it is stacked on and to merge after it", async () => {
  const delivery = await readPullRequestDelivery();
  assert.deepEqual(
    missingPhrases(delivery, ['The PR body names the PR it is stacked on and says "merge after #<parent>".']),
    [],
  );
});

test("execute-todos no longer tells a campaign to copy another pull request's function under a twin name", async () => {
  const skill = await readFile(path.join(ROOT, ".claude/skills/execute-todos/SKILL.md"), "utf8");
  const unwrapped = skill.replace(/\s*\n\s*/g, " ");
  const survivingOldRule = [
    "stands on the default branch, never on another PR",
    "non-colliding name",
    "ForCurrentFunction",
    "never base the branch on the other PR",
    "never edit a line the other PR edits",
    "Consolidating the copies",
  ].filter((phrase) => unwrapped.includes(phrase));
  assert.deepEqual(survivingOldRule, []);
});
