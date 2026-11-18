import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { removeWebSearchProfileCopy, webSearchProfileCopy } from "../src/reap-agent/scratch-cleanup.ts";

test("reaping an agent removes its own web-search profile copy and leaves the base profile alone", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "web-search-profile-"));
  try {
    const base = path.join(home, ".agent-browser", "profiles", "web-search");
    const copy = webSearchProfileCopy("shadow-one", home);
    await mkdir(path.join(base, "Default"), { recursive: true });
    await mkdir(path.join(copy, "Default"), { recursive: true });
    await removeWebSearchProfileCopy("shadow-one", home);
    await assert.rejects(stat(copy));
    assert.ok((await stat(path.join(base, "Default"))).isDirectory());
    await removeWebSearchProfileCopy("never-searched", home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
