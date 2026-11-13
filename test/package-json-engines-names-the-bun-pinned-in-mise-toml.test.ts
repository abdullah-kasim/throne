import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readPinnedBunVersion } from "./pinned-bun.support.ts";

const REPO_ROOT = path.join(import.meta.dirname, "..");

test("package.json engines names the bun pinned in mise.toml and no node", async () => {
  const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));

  assert.deepEqual(packageJson.engines, { bun: await readPinnedBunVersion() });
});

test("mise.toml pins no node", async () => {
  const miseConfig = await readFile(path.join(REPO_ROOT, "mise.toml"), "utf8");

  assert.doesNotMatch(miseConfig, /^\s*node\s*=/m);
});
