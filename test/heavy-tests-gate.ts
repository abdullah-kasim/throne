// Gate for the expensive real-infrastructure tests (Lord-ordered
// 2026-08-19): the real-systemd rollback proof and every `.canary.test.ts`
// (real agent spawns, real herdr tabs, real worktrees). These are VERY
// important tests — each exists because a cheaper fake once lied — but far
// too expensive for the default suite's inner loop, so `npm test` skips
// them and `npm run test:heavy` runs them.
//
// AUTHORIZATION LAW: no agent (Regent, Stager, Alpha, Shadow) may run
// `npm run test:heavy` or set THRONE_HEAVY_TESTS without the Lord's DIRECT
// order in the current session. A standing preference, an inherited brief,
// or "the suite felt incomplete" is not an order. See AGENTS.md, "Hard
// rules of the court".

import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";

export type TestGroup = {
  environmentVariable: string;
  listFile?: string;
  skipNotice: (file: string) => string;
};

export type TestGroupListEntry = {
  file: string;
  seconds: number | null;
  reason: string;
};

export const heavyTestGroup: TestGroup = {
  environmentVariable: "THRONE_HEAVY_TESTS",
  skipNotice: () =>
    "# heavy real-infrastructure test gated out of the default suite — " +
    "run via `npm run test:heavy` ONLY on the Lord's direct order",
};

export const slowTestGroup: TestGroup = {
  environmentVariable: "THRONE_SLOW_TESTS",
  listFile: "test/slow-tests.json",
  skipNotice: (file) => `# slow test file skipped: ${file}`,
};

export const containerTestGroup: TestGroup = {
  environmentVariable: "THRONE_CONTAINER_TESTS",
  listFile: "test/container-tests.json",
  skipNotice: (file) => `# container test file skipped: ${file}`,
};

export const listedTestGroups = [slowTestGroup, containerTestGroup];

export const allTestGroups = [heavyTestGroup, ...listedTestGroups];

export const NO_LISTED_TEST_FILES_NOTICE = "# no test files are listed in the enabled test groups";

export function isTestGroupEnabled(
  group: TestGroup,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment[group.environmentVariable] === "1";
}

export function gateHeavyTestFile(): void {
  if (isTestGroupEnabled(heavyTestGroup)) return;
  console.log(heavyTestGroup.skipNotice(""));
  process.exit(0);
}

export function readTestGroupList(
  group: TestGroup,
  repositoryRoot: string,
): TestGroupListEntry[] {
  if (!group.listFile) return [];
  const listPath = path.join(repositoryRoot, group.listFile);
  if (!existsSync(listPath)) return [];
  return JSON.parse(readFileSync(listPath, "utf8"));
}

export function listEnabledGroupTestFiles(
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): string[] {
  return listedTestGroups
    .filter((group) => isTestGroupEnabled(group, environment))
    .flatMap((group) => readTestGroupList(group, repositoryRoot).map((entry) => entry.file));
}

export const DEFAULT_TEST_TIMEOUT_MS = 180000;
export const HEAVY_TEST_TIMEOUT_MS = 600000;
const SUITE_TEST_FILES = "{test,src,scripts,extensions/shared,extensions/pi}/**/*.{test,spec}.ts";
const HEAVY_TEST_FILE = /(\.canary\.test\.ts|^src\/throne-backend\/rollback-guard-real-systemd\.spec\.ts)$/;

export type SuiteTestSelection = {
  files: string[];
  skipNotices: string[];
  timeoutMs: number;
};

function listSuiteTestFiles(repositoryRoot: string): string[] {
  return globSync(SUITE_TEST_FILES, { cwd: repositoryRoot }).sort();
}

export function selectSuiteTestFiles(
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): SuiteTestSelection {
  if (isTestGroupEnabled(heavyTestGroup, environment)) {
    const files = listSuiteTestFiles(repositoryRoot).filter((file) => HEAVY_TEST_FILE.test(file));
    return { files, skipNotices: [], timeoutMs: HEAVY_TEST_TIMEOUT_MS };
  }
  if (listedTestGroups.some((group) => isTestGroupEnabled(group, environment))) {
    const files = listEnabledGroupTestFiles(environment, repositoryRoot);
    return { files, skipNotices: [], timeoutMs: DEFAULT_TEST_TIMEOUT_MS };
  }
  const skipped = listedTestGroups.flatMap((group) =>
    readTestGroupList(group, repositoryRoot).map((entry) => ({ file: entry.file, notice: group.skipNotice(entry.file) })),
  );
  const skippedFiles = new Set(skipped.map((entry) => entry.file));
  const files = listSuiteTestFiles(repositoryRoot).filter(
    (file) => !HEAVY_TEST_FILE.test(file) && !skippedFiles.has(file),
  );
  return { files, skipNotices: skipped.map((entry) => entry.notice), timeoutMs: DEFAULT_TEST_TIMEOUT_MS };
}
