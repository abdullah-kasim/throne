import { spawnSync } from "node:child_process";
import { NO_LISTED_TEST_FILES_NOTICE, listEnabledGroupTestFiles } from "./heavy-tests-gate.ts";

const files = listEnabledGroupTestFiles(process.env, process.cwd());
if (files.length === 0) {
  console.log(NO_LISTED_TEST_FILES_NOTICE);
  process.exit(0);
}
const run = spawnSync(
  process.execPath,
  ["--import", "./test/register-typescript.mjs", "--test", "--test-timeout=180000", ...files],
  { stdio: "inherit" },
);
process.exit(run.status ?? 1);
