import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { missingPhrases, readMarkdownSection, readSkillSource, unwrap } from "./skill-contract-test-helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUILDER_STAMP = "`frontend_row: builder`";
const CRITIC_STAMP = "`frontend_row: critic`";

async function readSkillSection(skill: string, heading: string, file = "SKILL.md"): Promise<string> {
  const section = readMarkdownSection(await readSkillSource(skill, file), heading);
  assert.notEqual(section, "", `${skill} has no ${heading} section`);
  return unwrap(section);
}

function readFrontEndBundles(): Promise<string> {
  return readSkillSection("write-todos", "# Front-end bundles", "front-end-bundles.md");
}

function readVerifyTodo(): Promise<string> {
  return readSkillSection("write-todos", "# The verify todo (`99b_verify_<topic>.md`)", "verify-todo-template.md");
}

function readExecuteTodosVerifyGate(): Promise<string> {
  return readSkillSection("execute-todos", "#### `99b` — run the tests and lint, and fix what fails", "gate-99b-verify.md");
}

function readExecuteTodosCritiqueGates(): Promise<string> {
  return readSkillSection("execute-todos", "### Rubric critique gates — Shadow-run, bounded, resumed weakest-first", "rubric-critique-gates.md");
}

test("a builder bundle runs no front-end critic, no critique gate and no accessibility review", async () => {
  assert.deepEqual(
    missingPhrases(await readFrontEndBundles(), [
      "A builder bundle has no `## Front-end critique` block in `99b`, no `NNz_critique_` gates, no `bundle_content: perceptual`, and no accessibility review of any kind (keyboard walk, screen-reader checks, `/screen-reader-check`, or the accessibility parts of `/frontend-critic`).",
      "A builder `99b` that carries the critique block is malformed",
      "it delivers as soon as they pass",
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readVerifyTodo(), [
      "Run no `/frontend-critic` review and no accessibility review; the critic row owns both.",
      "only when 00_overview.md stamps frontend: true and not frontend_row: builder.",
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readExecuteTodosVerifyGate(), [
      "It runs no `/frontend-critic` review and no accessibility review, including `/screen-reader-check`.",
      "A builder delivers as soon as its gates pass",
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readExecuteTodosCritiqueGates(), [
      "A bundle stamped `frontend_row: builder` has no critique gates, so none of this applies to it",
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(unwrap(await readSkillSource("write-todos", "perceptual-quality-bundles.md")), [
      "A `frontend_row: builder` bundle never stamps it",
      "A `frontend_row: builder` bundle has no critique gates, so none of this applies to it.",
    ]),
    [],
  );
});

test("a builder bundle's verify gate checks the behaviour in a real browser", async () => {
  assert.deepEqual(
    missingPhrases(await readVerifyTodo(), [
      "only when 00_overview.md stamps frontend_row: builder.",
      "## Browser function check",
      "Rebuild and serve the assembled candidate, confirm the served bytes carry the change, then perform each `## Done when` behaviour in Chromium with agent-browser.",
      "A behaviour that does not work is a failure you fix here and commit",
      "with the browser function check one line per behaviour performed, naming Chromium",
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readFrontEndBundles(), [
      "a stamped builder whose `99b` lacks `## Browser function check` is malformed",
    ]),
    [],
  );
});

test("the builder stamp is refused unless the critic row is waiting on the builder", async () => {
  assert.deepEqual(
    missingPhrases(await readFrontEndBundles(), [
      "| `FRONTEND-ROW: builder, critic row <critic>` | `frontend_row: builder` |",
      "is stamped only when the body carries the builder line AND `throne situation-brief --objective-code <builder>` lists the critic under \"Deferred rows waiting on this objective\".",
      "Without both, the stamp is refused: leave it out and the bundle keeps its `99b` critique, so a dropped critic row costs speed and never the critic.",
    ]),
    [],
  );
});

test("a critic bundle runs the front-end critic and the screen-reader check and fixes what they raise", async () => {
  assert.deepEqual(
    missingPhrases(await readFrontEndBundles(), [
      "| `FRONTEND-ROW: critic of <builder>` | `frontend_row: critic` |",
      "and it always also stamps `frontend: true`",
      "Slice `01` first brings the tree up to the target branch and confirms the builder's delivery commit is present.",
      "the slice tells the Regent and parks on the builder's Alpha, because a deferred row can launch early by design",
      "then runs `/frontend-critic` and `/screen-reader-check` on the delivered surfaces and fixes every defect they raise",
      "That happens before `99a`, so the conformance gate grades the fixed work.",
      "`99b` keeps the `## Front-end critique` block, widened to `/screen-reader-check`, and finishes on empty reports.",
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readVerifyTodo(), [
      "only when 00_overview.md stamps frontend_row: critic.",
      "Run `/screen-reader-check`'s simulated pass on them too, fix what it raises the same way, and finish on an empty report from both.",
      "A critic row adds `/screen-reader-check`'s final empty report.",
    ]),
    [],
  );
});

test("a front-end bundle with no row stamp keeps its critique in the verify gate", async () => {
  assert.deepEqual(
    missingPhrases(await readFrontEndBundles(), [
      "**`frontend: true` with no `frontend_row:`** (a `/gauntlet` row, a row filed before this rule, a row never split) keeps its `## Front-end critique` block and its critique gates exactly as this skill describes them.",
      "A bundle with no `frontend_row:` runs it in `99b`",
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readExecuteTodosVerifyGate(), [
      "**`frontend: true` with no `frontend_row:`** (a /gauntlet row among them): the `## Front-end critique` block.",
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readExecuteTodosCritiqueGates(), [
      "every other `frontend: true` bundle follows it as written",
    ]),
    [],
  );
});

test("both todo skills state the same stamp", async () => {
  const stamps = [BUILDER_STAMP, CRITIC_STAMP];
  assert.deepEqual(missingPhrases(await readFrontEndBundles(), stamps), []);
  assert.deepEqual(missingPhrases(await readExecuteTodosVerifyGate(), stamps.map((stamp) => `**${stamp}:**`)), []);
  assert.deepEqual(
    missingPhrases(await readExecuteTodosVerifyGate(), ["/write-todos' \"Front-end bundles\" owns what they mean"]),
    [],
  );
});

test("the screen-reader check is recorded as a global skill", async () => {
  const manifest = await readFile(path.join(ROOT, ".claude/skill-dependencies.tsv"), "utf8");
  assert.ok(manifest.split("\n").includes("screen-reader-check\tglobal"));
});
