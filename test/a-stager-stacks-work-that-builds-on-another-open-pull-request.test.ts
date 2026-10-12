import { test } from "node:test";
import assert from "node:assert/strict";
import { missingPhrases, readBullet, readSkill } from "./skill-contract-test-helpers.ts";

test("a Stager cuts a pull request that builds on another open pull request from that pull request's branch", async () => {
  const skill = await readSkill("queue-objective");
  const rule = readBullet(skill, "Prefer stacking (Lord, 2026-10-05)");
  assert.deepEqual(
    missingPhrases(rule, [
      "Also, please prefer stacked PRs - update our skills in that case. Stacked PRs makes testing easier!",
      "calls that PR's API, uses its helpers, or edits its files",
      "Before filing against an existing branch, compare the local and remote tips",
      "`git -C <repo> branch <new> <parent-branch>`",
      "`--target-branch` and `--pr-branch` both set to the new branch and `--base-commit` from it",
      "state the parent PR and its branch in `SCOPE:`",
      "`/pr-split`'s execution contract",
      "file the child row deferred on the parent's row; the Regent releases it",
      "by merge, never by rebase or force push",
      "Independent work and unrelated tickets still branch from the default branch",
      "lands through `/pr-merge`",
    ]),
    [],
  );
  const pullRequestDeliverable = readBullet(skill, "A pull request as deliverable");
  assert.deepEqual(
    missingPhrases(pullRequestDeliverable, [
      "or from the parent PR's branch for a stacked row",
      "or to the parent PR's branch for a stacked row",
    ]),
    [],
  );
  const pullRequestSplit = await readSkill("pr-split");
  assert.ok(pullRequestSplit.includes("A stacked PR starts with `git merge --ff-only <parent-branch>`"));
});

test("queue-objective no longer tells a Stager to copy another pull request's helper under a twin name", async () => {
  const skill = await readSkill("queue-objective");
  const survivingOldRule = [
    "Never stack one PR on another",
    "never from another open PR's branch",
    "non-colliding name",
    "ForCurrentFunction",
    "Consolidation after merge",
    "unstacking it",
  ].filter((phrase) => skill.includes(phrase));
  assert.deepEqual(survivingOldRule, []);
});

test("a row coded against an open pull request it cannot stack on says so and names the push waiver", async () => {
  const skill = await readSkill("queue-objective");
  const rule = readBullet(skill, "A PR that codes against another open PR it cannot stack on");
  assert.deepEqual(
    missingPhrases(rule, [
      "another repository, or the Lord chose not to stack",
      "says so in `SCOPE:`",
      "`RULINGS:` note that the pre-push review may report findings about the other PR's code",
      "`throne push-waiver` and the reason `other-open-pr`",
    ]),
    [],
  );
});

test("a feature filed as several pull requests names its wiring pull request and stacks it on what it consumes", async () => {
  const skill = await readSkill("queue-objective");
  const rule = readBullet(skill, "Name the wiring PR when one feature is filed as several PRs");
  assert.deepEqual(
    missingPhrases(rule, [
      "The wiring PR is the one that consumes the others",
      "Stack it on the rows it consumes",
      "the end-to-end scenarios and the manual test walkthrough in its body",
      "the whole feature runs and tests from its branch",
      "the page PR is the wiring PR, stacked on the API PR",
    ]),
    [],
  );
});
