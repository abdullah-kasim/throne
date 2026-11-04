import { test } from "node:test";
import assert from "node:assert/strict";
import { missingPhrases, readMarkdownSection, readSkill, readSkillSource, unwrap } from "./skill-contract-test-helpers.ts";

async function readSection(skillName: string, heading: string): Promise<string> {
  const section = readMarkdownSection(await readSkillSource(skillName), heading);
  assert.notEqual(section, "", `${skillName} has no ${heading} section`);
  return unwrap(section);
}

test("a yolo repository's campaign is delivered by pushing its default branch, never by a pull request", async () => {
  const delivery = await readSection("execute-todos", "#### Yolo delivery — when the repository pushes its default branch");
  assert.deepEqual(
    missingPhrases(delivery, [
      'git -C "$repo" config --type=bool --get throne.yolo` prints `true`',
      "`refs/remotes/origin/HEAD` names",
      "Open no pull request.",
      'git -C "$repo" fetch origin',
      'git -C "$repo" merge "origin/$default"',
      'git -C "$repo" merge "$target_branch"',
      'git -C "$repo" push origin "$default"',
      "resolve every conflict there",
      "`npm run build`, `npm test` and `npm run lint`; never the heavy tier",
      "never forced",
      "Never `--force`.",
      "rebuild the live `dist/`",
      "--is-ancestor <campaign head> \"origin/$default\"` exits 0",
      "the commit now at `origin/<default>` is the one that was built, tested and linted",
      "records that commit's SHA",
      "The `99c` file ends in `**Delivery outcome:** PASS at <full sha of the commit now at origin/<default>>`.",
      "`complete-agent` and `reap-agent --reason completed` refuse both the delivering Shadow and the campaign Alpha",
      "not a refusal of any pull-request command",
    ]),
    [],
  );
  const finalDelivery = await readSection("execute-todos", "#### `99c` — merge the latest target, resolve conflicts, deliver");
  assert.ok(finalDelivery.includes("outside a yolo repository this step issues no `git fetch` and never names `origin/...`"));
});

test("a single-slice campaign in a yolo repository delivers the same way", async () => {
  const singleSlice = await readSection("execute-todos", "## Single-slice mode — Lord-authorized only");
  assert.deepEqual(
    missingPhrases(singleSlice, [
      "`99c` then run exactly as for any bundle, each as a fresh Shadow distinct from the executor, and you do the `99d` record step yourself",
      "yolo delivery, pull-request delivery, deferred release and the record step on the Lord's page are the ordinary sections above and below, unchanged.",
    ]),
    [],
  );
});

test("a queue row for a yolo repository needs no pull request branch", async () => {
  const filing = await readSkill("queue-objective");
  assert.deepEqual(
    missingPhrases(filing, [
      "`git -C <repo> config --type=bool --get throne.yolo` prints `true`, the row needs no `--pr-branch`",
      'its `SCOPE:` says "lands on <default> and pushes"',
      '/execute-todos "Yolo delivery"',
    ]),
    [],
  );
});
