import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { GRADE_NAMES, gradeNamesInTheLegacyCopy } from "../scripts/capability-removal-evidence/lines/legacy.mjs";

const runFile = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const BEFORE_FOLDER = path.join(REPO_ROOT, "test", "fixtures", "capability-removal-evidence", "before");
const COMMIT_BEFORE_THE_REMOVAL = "3c7e0b52d9a14f68e2b7c1d05a9f3e46b8d2c710";
const LEGACY_BEFORE_LINES = ["C1.2-legacy", "C1.3-legacy", "C1.4-legacy"];
const scratchFolders: string[] = [];

after(async () => {
  await Promise.all(scratchFolders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function treeWithLegacyFile(text: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "legacy-grade-names-"));
  scratchFolders.push(root);
  await mkdir(path.join(root, "src", "create-agent-legacy"), { recursive: true });
  await writeFile(path.join(root, "src", "create-agent-legacy", "create.ts"), text);
  const git = (...argumentsList: string[]) => runFile("git", ["-C", root, ...argumentsList]);
  await git("init", "-q");
  await git("add", ".");
  await git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "tree");
  return root;
}

test("the capability-name check finds a name the tree still holds and nothing when the tree holds none", async () => {
  const keptName = GRADE_NAMES.split("|")[0];
  const holding = await gradeNamesInTheLegacyCopy(await treeWithLegacyFile(`export const ${keptName} = 1;\n`));
  assert.match(holding.found.stdout, new RegExp(keptName));
  const clean = await gradeNamesInTheLegacyCopy(await treeWithLegacyFile("export const effort = 1;\n"));
  assert.equal(clean.found.stdout.trim(), "");
});

test("the legacy before answers are the ones recorded from the commit before the removal", async () => {
  for (const line of LEGACY_BEFORE_LINES) {
    const before = JSON.parse(await readFile(path.join(BEFORE_FOLDER, `${line}.json`), "utf8"));
    assert.equal(before.recorded_from, COMMIT_BEFORE_THE_REMOVAL, line);
  }
});
