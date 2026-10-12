import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..");
const SKILLS_DIRECTORY = path.join(REPOSITORY_ROOT, ".claude", "skills");
const PROMOTION_SKILLS = new Set(["pr-promote", "promote-pr"]);
const PROMOTE_INVOCATION = /\bforge promote\b/;
const PROMOTION_IMPORT = /from\s+["'][^"']*\/promotion\.ts["']/;
const PROMOTION_COMMAND_MODULE = path.join("src", "forge", "forge.command.ts");

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

test("no skill other than the promotion skill and its alias calls promote", async () => {
  const callers: string[] = [];
  for (const file of await filesUnder(SKILLS_DIRECTORY)) {
    const skill = path.relative(SKILLS_DIRECTORY, file).split(path.sep)[0]!;
    if (PROMOTION_SKILLS.has(skill)) continue;
    if (PROMOTE_INVOCATION.test(await readFile(file, "utf8"))) callers.push(path.relative(REPOSITORY_ROOT, file));
  }

  assert.deepEqual(callers, []);
  assert.match(await readFile(path.join(SKILLS_DIRECTORY, "pr-promote", "SKILL.md"), "utf8"), /\bforge promote\b/);
});

test("no code path other than the forge command reaches promotion", async () => {
  const importers: string[] = [];
  for (const file of await filesUnder(path.join(REPOSITORY_ROOT, "src"))) {
    if (!file.endsWith(".ts") || file.endsWith(path.join("src", "forge", "promotion.ts"))) continue;
    if (PROMOTION_IMPORT.test(await readFile(file, "utf8"))) importers.push(path.relative(REPOSITORY_ROOT, file));
  }

  assert.deepEqual(importers, [PROMOTION_COMMAND_MODULE]);
});
