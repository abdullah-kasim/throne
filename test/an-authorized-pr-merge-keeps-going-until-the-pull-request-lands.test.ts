import { test } from "node:test";
import assert from "node:assert/strict";
import { missingPhrases, readBullet, readSkill } from "./skill-contract-test-helpers.ts";

function readSection(unwrappedSkill: string, heading: string): string {
  const start = unwrappedSkill.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `no section is headed "${heading}"`);
  const end = unwrappedSkill.indexOf(" ## ", start + 1);
  return unwrappedSkill.slice(start, end === -1 ? undefined : end);
}

test("an authorized /pr-merge brings the root branch up to date by merge, before Prove and again before the merge", async () => {
  const skill = await readSkill("pr-merge");
  const rollAt = skill.indexOf("- **Roll**");
  const updateAt = skill.indexOf("- **Update**");
  const proveAt = skill.indexOf("- **Prove**");
  assert.ok(rollAt !== -1 && rollAt < updateAt && updateAt < proveAt, "Update sits after Roll and before Prove");
  assert.deepEqual(
    missingPhrases(readBullet(skill, "Update"), [
      "after the roll-up, `git merge origin/<default>` into the root branch, and again right before the merge whenever the default branch moved",
      "never rebase, never force-push",
      "the `mergeable` column `stack.mjs` already prints: `CONFLICTING`",
      "Resolve conflicts keeping both sides' intent; build, test, lint, push.",
    ]),
    [],
  );
  const identifyTheStack = readSection(skill, "1. Identify the stack");
  assert.ok(identifyTheStack.includes("A root that is `CONFLICTING` against the default branch is not a question for him: the row's **Update** step merges the default branch in and resolves it."));
  assert.ok(!identifyTheStack.includes("the roll-up needs a merge from the default branch first"));
});

test("an authorized /pr-merge waits for CI on the new head and fixes a failing check in its own commit", async () => {
  const skill = await readSkill("pr-merge");
  assert.deepEqual(
    missingPhrases(readBullet(skill, "Update"), [
      "Wait for CI on the new head with a Monitor until-loop, never chained sleeps.",
      "Fix a failing check in its own commit and wait again.",
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(readBullet(skill, "Fail"), [
      "an Expect not observed, or a red CI check on the head",
      "fix the latter on the root branch in its own commit with a test, push, wait for CI as **Update** says",
    ]),
    [],
  );
});

test("/pr-merge re-proves the criteria only when the update or a fix touched the pull request's files", async () => {
  const skill = await readSkill("pr-merge");
  assert.deepEqual(
    missingPhrases(readBullet(skill, "Prove"), [
      "run the criteria (the Lord's answer to the second question)",
      "Re-run the criteria on the new head when the update or a fix touched files the PR changes; otherwise the last proof stands.",
    ]),
    [],
  );
  const askTheLord = readSection(skill, "2. Ask the Lord two things, and only these");
  assert.deepEqual(
    missingPhrases(askTheLord, ["1. **Which pull request**", "2. **What is the criteria that allows the merge?**"]),
    [],
  );
});

test("when the Lord orders a merge without naming criteria, /pr-merge defaults them to CI green plus the root pull request's own Testing scenarios and does not ask", async () => {
  const askTheLord = readSection(await readSkill("pr-merge"), "2. Ask the Lord two things, and only these");
  assert.deepEqual(
    missingPhrases(askTheLord, [
      "When his order names no criteria, do not ask",
      "CI green on the final head plus the root PR body's own Testing scenarios, run on the updated head",
      "recorded under `RULINGS:` as the default, with his words quoted",
    ]),
    [],
  );
});

test("a root pull request with no Testing section defaults the merge criteria to CI green only", async () => {
  const askTheLord = readSection(await readSkill("pr-merge"), "2. Ask the Lord two things, and only these");
  assert.ok(askTheLord.includes("A root pull request with no `## Testing` section defaults to CI green only, and `RULINGS:` says so."));
});

test("named merge criteria are still written in the Lord's words verbatim", async () => {
  const askTheLord = readSection(await readSkill("pr-merge"), "2. Ask the Lord two things, and only these");
  assert.ok(askTheLord.includes("The criteria is what the campaign proves and what the merge waits on; write it verbatim."));
});

test("without an explicit order to merge, /pr-merge gets the pull request ready and leaves it open, and the Stager does not ask whether it may merge", async () => {
  const skill = await readSkill("pr-merge");
  assert.ok(!skill.includes("Do we allow it to merge?"));
  assert.ok(!skill.includes("three things"));
  assert.deepEqual(
    missingPhrases(readSection(skill, "2. Ask the Lord two things, and only these"), [
      'Without an explicit order to merge ("merge it", "squash and merge", "land it"), the row gets the pull request ready (roll up, update, prove, repromote) and does not merge; the root stays open, ready for merge.',
      "The Stager does not ask whether it may merge.",
    ]),
    [],
  );
});

test("the row merges only when its RULINGS quote an explicit merge order, and otherwise ends ready for merge with the head sha", async () => {
  const skill = await readSkill("pr-merge");
  assert.ok(readBullet(skill, "Merge").startsWith("- **Merge**: runs only when the RULINGS quote an explicit merge order"));
  assert.deepEqual(
    missingPhrases(readBullet(skill, "Ready"), [
      "when the root has a Forgejo twin, repromote it with `/pr-promote`",
      'Without an explicit merge order in the RULINGS, the row ends here: the root stays open, ready for merge, and REPORT.md records "ready for merge" plus the head sha.',
    ]),
    [],
  );
});

test("with an explicit merge order the row gets the pull request ready and then merges", async () => {
  const skill = await readSkill("pr-merge");
  const proveAt = skill.indexOf("- **Prove**");
  const readyAt = skill.indexOf("- **Ready**");
  const mergeAt = skill.indexOf("- **Merge**");
  assert.ok(proveAt < readyAt && readyAt < mergeAt, "Ready sits after Prove and before Merge");
  assert.ok(
    readSection(skill, "2. Ask the Lord two things, and only these").includes(
      "With an explicit order to merge, quoted under `RULINGS:`, the row does both: every ready step, then the **Merge** step.",
    ),
  );
  assert.ok(readBullet(skill, "Merge").includes("it comes after every ready step above"));
});

test("the Forgejo twin is closed only after an actual merge", async () => {
  const skill = await readSkill("pr-merge");
  assert.ok(readSection(skill, "1. Identify the stack").includes("Put that close step into the row (below); it runs only after an actual merge."));
  assert.ok(skill.includes("Only after an actual merge, right after reading it back as `MERGED`, close its Forgejo twin"));
});

test("a merge the Lord authorized without review uses --admin for the missing approval only and never bypasses a failing check", async () => {
  const skill = await readSkill("pr-merge");
  assert.deepEqual(
    missingPhrases(readBullet(skill, "Merge"), [
      "When the Lord's words authorize merging without review, recorded under `RULINGS:`, the command is `<gh> pr merge <root> --squash --admin --delete-branch=false`",
      "`--admin` covers ONLY the missing-approval requirement",
      "A failing required check is never bypassed: it is made to pass",
      "Without the no-review authorization, a refusal from branch protection for a missing approval is NOT bypassed: comment the refusal on the root",
      "the exact refusal GitHub printed, and that nothing was forced (no admin merge, no auto-merge, no protection change)",
    ]),
    [],
  );
});

test("/pr-merge stops only for a foreign push or a refusal nothing can clear, and never asks the Lord", async () => {
  const skill = await readSkill("pr-merge");
  assert.deepEqual(
    missingPhrases(readBullet(skill, "Stop"), [
      "the row stops for only two things: a push to the root branch by someone else, whose intent is unknown; and a refusal that no fix and no granted bypass can clear",
      "Each gets the refusal comment on the root",
      "a report to the supervisor; the Lord is never asked",
    ]),
    [],
  );
  assert.ok(readBullet(skill, "Update").includes("A moved default branch, a conflict, or a red check is work to do, never a reason to stop and ask."));
  assert.ok(readBullet(skill, "Fail").includes("An Expect or a check that still fails after a genuine fix is a refusal no fix can clear"));
});

test("/pr-merge always squash-merges and never asks the merge method", async () => {
  const skill = await readSkill("pr-merge");
  assert.ok(readBullet(skill, "Merge").includes("The merge method is always squash and is never asked"));
});
