import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { lintQueuePlanBody } from "../src/lint-queue-plan/lint-queue-plan.ts";
import type { RegentQueueItemRow } from "../src/regent-queue/regent-queue.store.ts";
import { readDeferredRowsWaitingOn } from "../src/situation-brief/deferred-rows-waiting.ts";
import {
  missingPhrases,
  readBullet,
  readMarkdownSection,
  readSkill,
  readSkillSource,
  unwrap,
} from "./skill-contract-test-helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CRITIC_DEFERRAL_FENCE = [
  "  ```bash",
  "  throne update-queue --objective-code <critic> --status deferred \\",
  '    --depends-on <builder> --defer-reason "<critic> critiques what <builder> delivers"',
  "  ```",
].join("\n");

async function readWebUiRule(): Promise<string> {
  return readBullet(await readSkill("queue-objective"), "A row that changes a web UI");
}

async function readAgentDoc(name: string): Promise<string> {
  return unwrap(await readFile(path.join(ROOT, "agent_docs", name), "utf8"));
}

function rowWaitingOn(objectiveCode: string, dependency: string): RegentQueueItemRow {
  return { id: objectiveCode, objectiveCode, deferral: { dependsOn: [dependency] } } as unknown as RegentQueueItemRow;
}

test("a row that changes a web UI is filed as a builder row and a deferred critic row", async () => {
  const rule = await readWebUiRule();
  assert.deepEqual(
    missingPhrases(rule, [
      "is filed as two rows in one sitting, builder first",
      "its gates check function only (tests, conformance, the behaviour working in a real browser)",
      "it runs no `/frontend-critic` review, no front-end critique gate",
      "it delivers as soon as they pass",
      "runs everything `/frontend-critic` does on the delivered work",
      "`FRONTEND-ROW: builder, critic row <critic>`",
      "`FRONTEND-ROW: critic of <builder>`",
      "A row delivered by pull request files its critic as a stacked row under \"Prefer stacking\"",
    ]),
    [],
  );
  const body = [
    "INTENT: show the discount on every invoice line.",
    "SCOPE: the invoice page.",
    "RULINGS: filed as two rows.",
    "VERIFIED-NOUNS: formatMoney.",
    "REUSE: web/money.ts:12 formatMoney already formats prices.",
    "FRONTEND-ROW: builder, critic row shopcritic",
  ].join("\n");
  assert.deepEqual(lintQueuePlanBody(body), []);
});

test("the critic row waits on the builder and the builder's Alpha asks for its release", async () => {
  const rule = await readWebUiRule();
  assert.deepEqual(
    missingPhrases(rule, [
      "defer the critic straight after filing, before an autoscaler tick can launch it as an open row, with:",
      "The builder's Alpha asks the Regent for release once delivered, as /gauntlet's checker does",
      "`throne release-deferred`",
    ]),
    [],
  );
  assert.ok((await readSkillSource("queue-objective")).includes(CRITIC_DEFERRAL_FENCE));
  const [launchBriefSection] = readDeferredRowsWaitingOn([rowWaitingOn("shopcritic", "shopbuilder")], "shopbuilder");
  assert.ok(launchBriefSection, "the builder's launch brief lists the waiting critic row");
  assert.ok(rule.includes(`"${launchBriefSection.title}"`));
});

test("the critic row confirms the builder's commit before it critiques", async () => {
  assert.deepEqual(
    missingPhrases(await readWebUiRule(), [
      "TRAP, written into the critic body: its base commit predates the delivery, and a deferred row can launch early by design",
      "brings its tree up to the target branch and confirms the builder's commit is present before critiquing",
      "it tells the Regent and parks on the builder's Alpha",
    ]),
    [],
  );
});

test("the builder row runs no accessibility review and the critic row fixes everything it raises", async () => {
  assert.deepEqual(
    missingPhrases(await readWebUiRule(), [
      "no front-end critique gate and no accessibility review",
      "runs the accessibility checks beside it, fixes everything they raise, then delivers",
      '`/write-todos` "Front-end bundles" holds the list of checks',
    ]),
    [],
  );
});

test("a critic row cannot be dropped and the skill says why no filing check exists", async () => {
  assert.deepEqual(
    missingPhrases(await readWebUiRule(), [
      "The critic row may not be dropped",
      "the builder is filed first, so the critic row does not exist yet",
      "`update-queue --depends-on` records codes without resolving them",
      '"changes a web UI" is not machine-readable at filing',
      "`/write-todos` refuses the builder stamp unless the critic row is waiting on the builder",
    ]),
    [],
  );
});

test("the front-end critic no longer claims to run for every front-end bundle", async () => {
  const critic = await readSkill("frontend-critic");
  const coding = await readAgentDoc("coding_principles.md");
  const skills = await readAgentDoc("skills.md");
  assert.deepEqual(
    [
      "runs it for every bundle stamped",
      "part of the `99b` verify gate whenever",
    ].filter((claim) => critic.includes(claim)),
    [],
  );
  assert.ok(!coding.includes("verify gate of every bundle stamped"));
  assert.ok(!skills.includes("puts the critique block into `99b`, so the verify gate runs it for campaign work"));
  assert.deepEqual(
    missingPhrases(critic, [
      "A critic row's Alpha runs it on what the builder row delivered, a front-end bundle with no `frontend_row:` stamp keeps it in the `99b` verify gate",
      "In a campaign the critic row's Alpha runs it on what the builder row delivered, and the builder row runs none of it",
      "A bundle stamped `frontend: true` with no `frontend_row:` stamp keeps it in the `99b` verify gate",
      "In a `99b` that carries this review, the final empty report",
    ]),
    [],
  );
  assert.ok(coding.includes("the critic row's Alpha runs this on what the builder row delivered"));
  assert.ok(skills.includes("A bundle with no `frontend_row:` stamp keeps the critique block in `99b`"));
});

test("a gauntlet row keeps its own critic loop and is not split further", async () => {
  const filingStep = unwrap(readMarkdownSection(await readSkillSource("gauntlet"), "## 13. File both rows"));
  assert.deepEqual(
    missingPhrases(filingStep, [
      "That rule does not reach a gauntlet: its behaviour is unchanged",
      "its bundles carry no `frontend_row:` stamp",
      "its own critic gates (step 5) and checker row (step 10) stand",
    ]),
    [],
  );
  assert.ok((await readWebUiRule()).includes("A /gauntlet row is not split further"));
});
