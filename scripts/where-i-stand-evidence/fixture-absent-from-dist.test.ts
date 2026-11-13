import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FIXTURE_MARKER, PINNED_NOW } from "./fixture.ts";

const builtOutput = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");

async function builtFilesHolding(words: readonly string[]): Promise<string[]> {
  const entries = await readdir(builtOutput, { recursive: true, withFileTypes: true });
  const holding: string[] = [];
  for (const entry of entries.filter((each) => each.isFile())) {
    const file = path.join(entry.parentPath, entry.name);
    const text = await readFile(file, "utf8");
    if (words.some((word) => text.includes(word))) holding.push(path.relative(builtOutput, file));
  }
  return holding;
}

test("the built output holds neither the fixture marker nor the fixture's pinned clock", async () => {
  assert.deepEqual(await builtFilesHolding([FIXTURE_MARKER, PINNED_NOW.toISOString()]), []);
});
