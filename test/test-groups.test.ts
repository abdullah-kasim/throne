import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  containerTestGroup,
  listEnabledGroupTestFiles,
  readTestGroupList,
  slowTestGroup,
} from "./heavy-tests-gate.ts";
import { pathExists } from "../src/git-lifecycle/git-command.service.ts";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRELOAD = path.join(REPOSITORY_ROOT, "test", "register-typescript.mjs");
const HEAVY_GATE = path.join(REPOSITORY_ROOT, "test", "heavy-tests-gate.ts");
const HEAVY_SKIP_NOTICE =
  "# heavy real-infrastructure test gated out of the default suite — " +
  "run via `npm run test:heavy` ONLY on the Lord's direct order";

function environmentWithoutGroups(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.THRONE_SLOW_TESTS;
  delete environment.THRONE_CONTAINER_TESTS;
  delete environment.THRONE_HEAVY_TESTS;
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

async function createRepositoryWithGroups(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "test-groups-"));
  await mkdir(path.join(root, "test"));
  const entry = (file: string) => [{ file, seconds: null, reason: "fixture" }];
  await writeFile(path.join(root, "test", "slow-tests.json"), JSON.stringify(entry("test/slow.test.ts")));
  await writeFile(path.join(root, "test", "container-tests.json"), JSON.stringify(entry("test/container.test.ts")));
  await writeFile(path.join(root, "test", "loaded-marker.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("loaded", "yes");\n');
  for (const name of ["slow", "container"]) {
    await writeFile(path.join(root, "test", `${name}.test.ts`), 'import "./loaded-marker.mjs";\nthrow new Error("loaded");\n');
  }
  return root;
}

const runNode = promisify(execFile);

function runDefaultTests(root: string, files: string[]) {
  return runNode(process.execPath, ["--import", PRELOAD, "--test", ...files], {
    cwd: root,
    env: environmentWithoutGroups(),
  });
}

function countLines(output: string, line: string): number {
  return output.split("\n").filter((outputLine) => outputLine.trim() === line).length;
}

async function packageScripts(): Promise<Record<string, string>> {
  return JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "package.json"), "utf8")).scripts;
}

test("the default test run skips the slow and container groups and says so once per skipped file", async () => {
  const root = await createRepositoryWithGroups();
  const run = await runDefaultTests(root, ["test/slow.test.ts", "test/container.test.ts"]);
  assert.equal(countLines(run.stdout, "# slow test file skipped: test/slow.test.ts"), 1);
  assert.equal(countLines(run.stdout, "# container test file skipped: test/container.test.ts"), 1);
});

test("an agent can run the slow group alone with npm run test:slow", async () => {
  const root = await createRepositoryWithGroups();
  assert.match((await packageScripts())["test:slow"], /^THRONE_SLOW_TESTS=1 .*scripts\/run-suite-container\.mjs -- npm run test:groups:isolated$/);
  assert.match((await packageScripts())["test:groups:isolated"], /test\/run-test-groups\.ts$/);
  assert.deepEqual(listEnabledGroupTestFiles({ THRONE_SLOW_TESTS: "1" }, root), ["test/slow.test.ts"]);
});

test("an agent can run the container group alone with npm run test:containers", async () => {
  const root = await createRepositoryWithGroups();
  assert.match((await packageScripts())["test:containers"], /^THRONE_CONTAINER_TESTS=1 .*scripts\/run-suite-container\.mjs -- npm run test:groups:isolated$/);
  assert.deepEqual(listEnabledGroupTestFiles({ THRONE_CONTAINER_TESTS: "1" }, root), ["test/container.test.ts"]);
});

test("the slow group does not run container tests unless asked", async () => {
  const root = await createRepositoryWithGroups();
  assert.ok(!listEnabledGroupTestFiles({ THRONE_SLOW_TESTS: "1" }, root).includes("test/container.test.ts"));
  assert.deepEqual(
    listEnabledGroupTestFiles({ THRONE_SLOW_TESTS: "1", THRONE_CONTAINER_TESTS: "1" }, root),
    ["test/slow.test.ts", "test/container.test.ts"],
  );
  assert.deepEqual(listEnabledGroupTestFiles({}, root), []);
});

test("a skipped test file costs almost nothing because its imports never load", async () => {
  const root = await createRepositoryWithGroups();
  const run = await runDefaultTests(root, ["test/slow.test.ts"]);
  assert.doesNotMatch(run.stdout + run.stderr, /Error: loaded/);
  assert.equal(await pathExists(path.join(root, "loaded")), false);
});

test("every listed slow or container test file exists and says why it is slow", async () => {
  const slowFiles = readTestGroupList(slowTestGroup, REPOSITORY_ROOT);
  const containerFiles = readTestGroupList(containerTestGroup, REPOSITORY_ROOT);
  assert.ok(slowFiles.length > 0);
  for (const entry of [...slowFiles, ...containerFiles]) {
    assert.ok(await pathExists(path.join(REPOSITORY_ROOT, entry.file)), `${entry.file} does not exist`);
    assert.ok(entry.reason.trim().length > 0, `${entry.file} gives no reason`);
    assert.ok(entry.seconds === null || typeof entry.seconds === "number", `${entry.file} has no measured seconds`);
  }
  const containerFileNames = new Set(containerFiles.map((entry) => entry.file));
  for (const entry of slowFiles) {
    assert.ok(!containerFileNames.has(entry.file), `${entry.file} is in both groups`);
  }
});

const FORGE_TEST_TARGET_SECONDS = 2;

function isForgeTestFile(file: string): boolean {
  return file.startsWith("src/forge/") || file.startsWith("test/forge");
}

test("every forge test in the default run finishes in under two seconds or is listed slow with its reason", () => {
  const listedForgeFiles = readTestGroupList(slowTestGroup, REPOSITORY_ROOT).filter((entry) => isForgeTestFile(entry.file));
  assert.ok(listedForgeFiles.length > 0);
  for (const entry of listedForgeFiles) {
    assert.ok(typeof entry.seconds === "number" && entry.seconds > FORGE_TEST_TARGET_SECONDS, `${entry.file} is listed slow without a measured time over two seconds`);
    assert.ok(entry.reason.trim().length > 0, `${entry.file} gives no reason`);
  }
});

test("the heavy group behaves exactly as before", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "heavy-group-"));
  const heavyFile = path.join(root, "heavy.test.mts");
  await writeFile(heavyFile, `import { gateHeavyTestFile } from ${JSON.stringify(HEAVY_GATE)};\ngateHeavyTestFile();\nconsole.log("ran past the gate");\n`);
  const run = await runNode(process.execPath, [heavyFile], { cwd: root, env: environmentWithoutGroups() });
  assert.equal(run.stdout, `${HEAVY_SKIP_NOTICE}\n`);
  assert.equal(
    (await packageScripts())["test:heavy"],
    "THRONE_HEAVY_TESTS=1 node --import ./test/register-typescript.mjs scripts/run-suite-container.mjs -- npm run test:heavy:isolated",
  );
  assert.equal(
    (await packageScripts())["test:heavy:isolated"],
    "node --import ./test/register-typescript.mjs --test --test-timeout=600000 'test/**/*.canary.test.ts' 'src/throne-backend/rollback-guard-real-systemd.spec.ts'",
  );
});
