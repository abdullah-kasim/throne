import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NO_LISTED_TEST_FILES_NOTICE, selectSuiteTestFiles } from "./heavy-tests-gate.ts";
import { formatJunitSummary } from "./junit-test-summary.ts";

const selection = selectSuiteTestFiles(process.env, process.cwd());
for (const notice of selection.skipNotices) console.log(notice);
if (selection.files.length === 0) {
  console.log(NO_LISTED_TEST_FILES_NOTICE);
  process.exit(0);
}
const reportDirectory = mkdtempSync(path.join(tmpdir(), "suite-test-report-"));
const reportFile = path.join(reportDirectory, "junit.xml");
const run = spawnSync(
  process.execPath,
  [
    "test",
    "--parallel=16",
    `--timeout=${selection.timeoutMs}`,
    "--reporter=junit",
    `--reporter-outfile=${reportFile}`,
    ...selection.files.map((file) => `./${file}`),
  ],
  { stdio: "inherit" },
);
if (existsSync(reportFile)) process.stdout.write(formatJunitSummary(readFileSync(reportFile, "utf8")));
rmSync(reportDirectory, { recursive: true, force: true });
process.exitCode = run.status ?? 1;
