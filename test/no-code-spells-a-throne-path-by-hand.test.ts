import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARDED_FOLDERS = ["src", "scripts", "bin"];
const THRONE_HOME_RESOLVER = path.join("src", "shared-policy", "throne-home.ts");
const CAPTURED_PANE_FIXTURE_FOLDERS = [
  path.join("src", "no-idling", "fixtures"),
  path.join("src", "pane-prompts", "fixtures"),
];
const TEST_FILE_ENDINGS = [".spec.ts", ".test.ts"];

const HAND_SPELLED_THRONE_PATHS = [
  /'\.throne'/,
  /"\.throne"/,
  /~\/\.throne/,
  /\.throne\//,
  /\.config\/throne/,
  /['"]\.config['"]\s*\)*\s*,\s*['"]throne['"]/,
];

function isTestFile(relativePath: string): boolean {
  return TEST_FILE_ENDINGS.some((ending) => relativePath.endsWith(ending));
}

function isCapturedPaneFixture(relativePath: string): boolean {
  return CAPTURED_PANE_FIXTURE_FOLDERS.some((folder) => relativePath.startsWith(`${folder}${path.sep}`));
}

function isGuardedFile(relativePath: string): boolean {
  return relativePath !== THRONE_HOME_RESOLVER && !isTestFile(relativePath) && !isCapturedPaneFixture(relativePath);
}

async function filesUnder(folder: string): Promise<string[]> {
  const entries = await readdir(path.join(REPOSITORY_ROOT, folder), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(REPOSITORY_ROOT, path.join(entry.parentPath, entry.name)));
}

async function guardedFiles(): Promise<string[]> {
  const files = await Promise.all(GUARDED_FOLDERS.map(filesUnder));
  return files.flat().filter(isGuardedFile);
}

function spellsAThronePath(line: string): boolean {
  return HAND_SPELLED_THRONE_PATHS.some((pattern) => pattern.test(line));
}

async function handSpelledThronePathsIn(relativePath: string): Promise<string[]> {
  const contents = await readFile(path.join(REPOSITORY_ROOT, relativePath), "utf8");
  return contents
    .split("\n")
    .flatMap((line, index) => (spellsAThronePath(line) ? [`${relativePath}:${index + 1}: ${line.trim()}`] : []));
}

test("no code outside the throne home resolver spells a throne path by hand", async () => {
  const offendersByFile = await Promise.all((await guardedFiles()).map(handSpelledThronePathsIn));
  const offenders = offendersByFile.flat();
  assert.deepEqual(offenders, [], `ask ${THRONE_HOME_RESOLVER} for these paths instead:\n${offenders.join("\n")}`);
});
