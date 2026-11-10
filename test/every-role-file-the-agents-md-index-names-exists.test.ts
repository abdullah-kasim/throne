import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const ROLES = ["regent", "stager", "alpha", "shadow"];

async function roleFilesIndex(): Promise<string> {
  const law = await readFile(resolve(REPOSITORY_ROOT, "AGENTS.md"), "utf8");
  const start = law.indexOf("## Role files\n");
  assert.notEqual(start, -1, "AGENTS.md has no Role files index");
  return law.slice(start, law.indexOf("\n## ", start + 1));
}

test("every role file the AGENTS.md index names exists", async () => {
  const index = await roleFilesIndex();
  assert.match(index, /read your own role's file before acting/);
  const named = [...index.matchAll(/`(agent_docs\/role-[a-z]+\.md)`/g)].map((match) => match[1]);
  assert.deepEqual(named, ROLES.map((role) => `agent_docs/role-${role}.md`));
  for (const file of named) {
    await assert.doesNotReject(access(resolve(REPOSITORY_ROOT, file)), `${file} is named in the AGENTS.md index but does not exist`);
  }
});
