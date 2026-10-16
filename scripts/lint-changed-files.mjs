import { spawnSync } from "node:child_process";
import { CHANGED_FILES_ENVIRONMENT_VARIABLE, chooseLintTargets, createLintArguments } from "./suite-changed-files.mjs";

const lintTargets = chooseLintTargets(process.env[CHANGED_FILES_ENVIRONMENT_VARIABLE]);
if (!lintTargets.lintEverything && lintTargets.files.length === 0) {
  console.log("lint-changed-files: no files changed against main, nothing to lint before the tests");
  process.exit(0);
}
console.log(
  lintTargets.lintEverything
    ? "lint-changed-files: the files changed against main are unknown, so every file is linted"
    : `lint-changed-files: linting ${lintTargets.files.length} file(s) changed against main`,
);
const lint = spawnSync("eslint", createLintArguments(lintTargets), { stdio: "inherit" });
if (lint.error) {
  console.error(`lint-changed-files: failed to run eslint: ${lint.error.message}`);
  process.exit(1);
}
process.exit(lint.status ?? 1);
