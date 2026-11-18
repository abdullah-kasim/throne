import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import { runLintQueuePlan, type LintQueuePlanDependencies } from "./lint-queue-plan.command.ts";
import { LAUNCH_READY_BODY, REAL_SPEC_ID, makeSpecCitationFixture } from "./spec-citation.test-support.ts";

const fixture = await makeSpecCitationFixture();
after(() => fixture.remove());

const UNCITED_BODY = `${LAUNCH_READY_BODY}\nREUSE: none found.`;
const CITED_BODY = `${LAUNCH_READY_BODY}\nREUSE: specs/greeting/greeter.md (${REAL_SPEC_ID}) — says hello.`;

async function lint(passedParams: string[], rowTargetRepo: string | null = null) {
  let stdout = "";
  let stderr = "";
  const dependencies: LintQueuePlanDependencies = {
    readRowByObjectiveCode: () => ({ body: UNCITED_BODY, targetRepo: rowTargetRepo }),
    readBodyFile: (file) => (file.endsWith("cited.md") ? CITED_BODY : UNCITED_BODY),
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  };
  const code = await runLintQueuePlan(passedParams, dependencies);
  return { code, stdout, stderr };
}

test("lint-queue-plan with a body file and no target repository gives today's output unchanged", async () => {
  const result = await lint(["--body-file", "plan.md"]);
  assert.deepEqual(result, {
    code: 0,
    stdout:
      "lint-queue-plan: body file plan.md structure ok: all five markers present (INTENT:, SCOPE:, RULINGS:, VERIFIED-NOUNS:, REUSE:). " +
      "This proves structure only — it is NOT evidence that decisions were genuinely closed with the Lord or that nouns were genuinely grep-verified; " +
      "that judgment remains the filing Stager's duty.\n",
    stderr: "",
  });
});

test("lint-queue-plan with a target repository refuses a body that cites nothing from its spec", async () => {
  const result = await lint(["--body-file", "plan.md", "--target-repo", fixture.specRepository]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /names none of its sub-feature IDs/);
  assert.match(result.stderr, /SPECS: none applies/);
});

test("lint-queue-plan with a target repository passes a cited body and says it proves only that an ID was copied", async () => {
  const result = await lint(["--body-file", "cited.md", "--target-repo", fixture.specRepository]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /proves an ID was copied from a spec file only — it is NOT evidence that the spec was read or understood/);
});

test("lint-queue-plan with an objective code checks against the row's own target repository", async () => {
  const result = await lint(["--objective-code", "loafcite"], fixture.specRepository);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /names none of its sub-feature IDs/);
});

test("lint-queue-plan with an objective code whose row has no target repository behaves as today", async () => {
  const result = await lint(["--objective-code", "loafcite"]);
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /sub-feature/);
});
