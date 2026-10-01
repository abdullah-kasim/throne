import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { RECALL_SECTION_FIELDS } from "../src/user-config-loader.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

test("the modify-config skill names every recall field", async () => {
  const skill = await readFile(path.join(ROOT, ".claude/skills/modify-config/SKILL.md"), "utf8");
  const recallRow = skill.split("\n").find((line) => line.startsWith("| `recall` |")) ?? "";
  const missing = RECALL_SECTION_FIELDS.filter((field) => !recallRow.includes(`\`${field}\``));
  assert.deepEqual(missing, []);
});
