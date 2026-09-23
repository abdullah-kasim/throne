import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const THRONE_ROOT = join(import.meta.dirname, "..");
const SKILLS_DIRECTORY = join(THRONE_ROOT, ".claude", "skills");
const MANIFEST_PATH = join(THRONE_ROOT, ".claude", "skill-dependencies.tsv");
const KINDS = new Set(["shipped", "global", "harness", "generated", "not-a-skill"]);

const SKILL_NAME = "[a-z][a-z0-9-]*[a-z0-9]";
const REFERENCE_PATTERNS = [
  new RegExp(`(?:^|[\\s\`("'])/(${SKILL_NAME})(?![\\w/.:-])`, "gm"),
  new RegExp(`\\bthe \`?/?(${SKILL_NAME})\`? skills?\\b`, "g"),
  new RegExp(`\`/?(${SKILL_NAME})\` skills?\\b`, "g"),
];

function readManifest(): Map<string, string> {
  const manifest = new Map<string, string>();
  for (const line of readFileSync(MANIFEST_PATH, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const [name, kind, ...extra] = line.split("\t");
    assert.equal(extra.length, 0, `manifest line has more than two fields: ${line}`);
    assert.ok(KINDS.has(kind), `manifest kind "${kind}" for ${name} is not one of ${[...KINDS].join(", ")}`);
    assert.ok(!manifest.has(name), `manifest lists ${name} twice`);
    manifest.set(name, kind);
  }
  return manifest;
}

function shippedSkills(): Set<string> {
  return new Set(
    readdirSync(SKILLS_DIRECTORY).filter((name) =>
      existsSync(join(SKILLS_DIRECTORY, name, "SKILL.md")),
    ),
  );
}

function referencedSkills(): Map<string, string> {
  const documents = [
    join(THRONE_ROOT, "AGENTS.md"),
    ...[...shippedSkills()].map((name) => join(SKILLS_DIRECTORY, name, "SKILL.md")),
  ];
  const references = new Map<string, string>();
  for (const document of documents) {
    const text = readFileSync(document, "utf8");
    for (const pattern of REFERENCE_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        if (!references.has(match[1])) references.set(match[1], document);
      }
    }
  }
  return references;
}

test("every skill named by a throne skill or AGENTS.md is shipped or recorded in the manifest", () => {
  const manifest = readManifest();
  const shipped = shippedSkills();
  const unrecorded = [...referencedSkills()]
    .filter(([name]) => !shipped.has(name) && !manifest.has(name))
    .map(([name, document]) => `${name} (named in ${document.slice(THRONE_ROOT.length + 1)})`);
  assert.deepEqual(unrecorded, [], "add each to .claude/skill-dependencies.tsv, or ship it in .claude/skills");
});

test("a manifest entry marked shipped really ships, and one marked global does not", () => {
  const shipped = shippedSkills();
  for (const [name, kind] of readManifest()) {
    if (kind === "shipped") assert.ok(shipped.has(name), `${name} is marked shipped but .claude/skills/${name}/SKILL.md is missing`);
    else assert.ok(!shipped.has(name), `${name} is marked ${kind} but throne ships it; mark it shipped`);
  }
});

test("every referenced shipped skill is recorded as shipped", () => {
  const manifest = readManifest();
  const shipped = shippedSkills();
  const missing = [...referencedSkills().keys()].filter(
    (name) => shipped.has(name) && manifest.get(name) !== "shipped",
  );
  assert.deepEqual(missing, []);
});
