import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { STEERING_SECTION_FIELDS } from "../src/user-config-loader.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

async function steeringOverrideKeys(): Promise<string[]> {
  const source = await readFile(path.join(ROOT, "src/steering-user-config.ts"), "utf8");
  const start = source.indexOf("export interface SteeringConfigOverride {");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  return [...body.matchAll(/^\s+readonly (\w+)\?:/gm)].map((match) => match[1]!);
}

test("the modify-config skill's field table names every SteeringConfigOverride key", async () => {
  const skill = await readFile(path.join(ROOT, ".claude/skills/modify-config/SKILL.md"), "utf8");
  const keys = await steeringOverrideKeys();
  assert.deepEqual([...keys].sort(), [...STEERING_SECTION_FIELDS].sort());
  const missing = keys.filter((key) => !skill.includes(`| \`${key}\` |`));
  assert.deepEqual(missing, []);
});
