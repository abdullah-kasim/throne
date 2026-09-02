import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const THRONE_DIR = fileURLToPath(new URL("..", import.meta.url));
export const GLOBAL_AGENT_DOCS_DIR = join(
  THRONE_DIR,
  "..",
  "claude/agent_docs",
);

export const COMPETENCE_DOCS = [
  "CRITICAL_coding_a_feature_masterplan.md",
  "coding_principles.md",
] as const;

export type RequiredClause = readonly [name: string, snippet: string];

export function codingPrinciplesText(): string {
  return readFileSync(
    join(THRONE_DIR, "agent_docs", "coding_principles.md"),
    "utf8",
  );
}

export function sectionTextForHeading(
  principles: string,
  heading: string,
  assertionName: string,
): string {
  const start = principles.indexOf(heading);
  assert.notEqual(start, -1, assertionName);
  const nextHeading = principles.indexOf("\n## ", start + heading.length);
  return principles.slice(start, nextHeading === -1 ? undefined : nextHeading);
}

export function sectionClauseProblems(
  section: string,
  requiredClauses: readonly RequiredClause[],
): string[] {
  return requiredClauses.flatMap(([name, snippet]) =>
    section.includes(snippet) ? [] : [`missing ${name}`],
  );
}
