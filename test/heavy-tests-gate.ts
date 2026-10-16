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

import { existsSync, readFileSync } from "node:fs";
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

export function gateTestFileByGroup(group: TestGroup, file: string): void {
  if (isTestGroupEnabled(group)) return;
  console.log(group.skipNotice(file));
  process.exit(0);
}

/**
 * Call as the first statement of a heavy test file. When the gate env is
 * absent the process exits 0 before any test registers — under node's
 * per-file test processes the file reports clean with zero tests, and the
 * skip notice lands in the runner output. When set to exactly "1", the file
 * runs normally.
 */
export function gateHeavyTestFile(): void {
  gateTestFileByGroup(heavyTestGroup, "");
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

export function findTestGroupOfFile(
  file: string,
  repositoryRoot: string,
): TestGroup | undefined {
  return listedTestGroups.find((group) =>
    readTestGroupList(group, repositoryRoot).some((entry) => entry.file === file),
  );
}

export function gateListedTestFile(entryPath: string, repositoryRoot: string): void {
  const file = path.relative(repositoryRoot, path.resolve(repositoryRoot, entryPath));
  const group = findTestGroupOfFile(file, repositoryRoot);
  if (group) gateTestFileByGroup(group, file);
}

export function listEnabledGroupTestFiles(
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): string[] {
  return listedTestGroups
    .filter((group) => isTestGroupEnabled(group, environment))
    .flatMap((group) => readTestGroupList(group, repositoryRoot).map((entry) => entry.file));
}
