import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { readMarkdownSection } from "./skill-contract-test-helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKILLS_WITH_THEIR_OWN_STACKING_TESTS = new Set(["queue-objective", "execute-todos"]);
const NEVER_STACK_WORDING = [
  "never stack",
  "never-stack",
  "stands on the default branch",
  "non-colliding name",
  "unstacked at landing",
  "copy it under",
  "forcurrentfunction",
  "consolidation after merge",
];

function readWithSingleSpaces(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8").replace(/\s+/g, " ");
}

function markdownFilesUnder(relativeDirectory: string): string[] {
  return readdirSync(path.join(ROOT, relativeDirectory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)));
}

function shippedDocsOutsideTheStackingSkills(): string[] {
  const skillDocs = markdownFilesUnder(".claude/skills").filter(
    (file) => !SKILLS_WITH_THEIR_OWN_STACKING_TESTS.has(file.split(path.sep)[2] ?? ""),
  );
  return ["AGENTS.md", ...markdownFilesUnder("agent_docs"), ...skillDocs];
}

test("across pull requests the wiring core is the consumer pull request stacked on its producers", () => {
  const skill = readFileSync(path.join(ROOT, ".claude/skills/plan-task-split/SKILL.md"), "utf8");
  const section = readMarkdownSection(skill, "## Across pull requests, the core is the wiring PR").replace(/\s+/g, " ");
  for (const phrase of [
    "the PR that consumes the others is the wiring PR",
    "stacked on the PRs it consumes",
    "run and tested end to end from its own branch",
    "the end-to-end tests and the manual test walkthrough",
    "recipe API PR and the recipe page PR",
  ]) {
    assert.ok(section.includes(phrase), `plan-task-split's wiring PR section says "${phrase}"`);
  }
});

test("no shipped skill or doc outside queue-objective and execute-todos still teaches never stacking", () => {
  const surviving = shippedDocsOutsideTheStackingSkills().flatMap((file) => {
    const text = readWithSingleSpaces(file).toLowerCase();
    return NEVER_STACK_WORDING.filter((wording) => text.includes(wording)).map((wording) => `${file}: ${wording}`);
  });
  assert.deepEqual(surviving, []);
  for (const file of ["AGENTS.md", "agent_docs/commands.md"]) {
    assert.ok(
      readWithSingleSpaces(file).includes('"Prefer stacking"'),
      `${file} lets a pull request branch start from the open pull request it builds on`,
    );
  }
});

test("a pull request stacked on another open one targets its parent's branch when its description is written", () => {
  const skill = readFileSync(path.join(ROOT, ".claude/skills/pr-description/SKILL.md"), "utf8");
  const beforeWriting = readMarkdownSection(skill, "## Before writing").replace(/\s+/g, " ");
  for (const phrase of [
    "A PR stacked on another open PR targets that PR's branch instead, with `--base <parent-branch>`",
    'says "merge after #<parent>"',
    '(`/execute-todos`, "Pull-request delivery")',
  ]) {
    assert.ok(beforeWriting.includes(phrase), `pr-description's Before writing says "${phrase}"`);
  }
  const creatingThePullRequest = readMarkdownSection(skill, "## Creating the PR");
  assert.ok(creatingThePullRequest.includes("--base <base-branch>"), "pr-description's create command takes the base chosen in Before writing");
  assert.ok(!creatingThePullRequest.includes("--base <default-branch>"), "pr-description's create command does not fix the base to the default branch");
});
