import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, initRepo } from "../test/git-repo-test-fixture.ts";
import {
  CHANGED_FILES_ENVIRONMENT_VARIABLE,
  LINT_EVERYTHING,
  chooseLintTargets,
  createLintArguments,
  formatChangedFilesForEnvironment,
  listFilesChangedAgainstMain,
} from "./suite-changed-files.mjs";

const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the files changed against main are linted before the tests run", async () => {
  const root = await initRepo("throne-changed-files-");
  try {
    await writeFile(path.join(root, "kept.ts"), "export const kept = 1;\n", "utf8");
    await writeFile(path.join(root, "removed.ts"), "export const removed = 1;\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "--no-gpg-sign", "-m", "two files"]);
    await git(root, ["checkout", "-b", "feature"]);
    await writeFile(path.join(root, "kept.ts"), "export const kept = 2;\n", "utf8");
    await git(root, ["commit", "--no-gpg-sign", "-am", "change kept"]);
    await unlink(path.join(root, "removed.ts"));
    await writeFile(path.join(root, "added.ts"), "export const added = 1;\n", "utf8");

    const changedFiles = listFilesChangedAgainstMain(root);
    assert.deepEqual(changedFiles, ["added.ts", "kept.ts"]);
    const handedIn = formatChangedFilesForEnvironment(changedFiles)[CHANGED_FILES_ENVIRONMENT_VARIABLE];
    assert.deepEqual(createLintArguments(chooseLintTargets(handedIn)).slice(-2), ["added.ts", "kept.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(listFilesChangedAgainstMain(path.join(root, "gone")), undefined);
  assert.deepEqual(formatChangedFilesForEnvironment(undefined), {});
  assert.equal(chooseLintTargets(undefined), LINT_EVERYTHING);
  assert.equal(chooseLintTargets("not a list"), LINT_EVERYTHING);
  assert.deepEqual(createLintArguments(LINT_EVERYTHING), ["."]);
  assert.deepEqual(chooseLintTargets("[]"), { lintEverything: false, files: [] });

  const testIsolated = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).scripts["test:isolated"];
  const changedFilesLintAt = testIsolated.indexOf("node scripts/lint-changed-files.mjs");
  assert.ok(changedFilesLintAt !== -1);
  assert.ok(changedFilesLintAt < testIsolated.indexOf("--test "));
});
