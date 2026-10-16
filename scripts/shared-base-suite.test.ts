import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { git, initRepo } from "../test/git-repo-test-fixture.ts";
import {
  SHARED_BASE_RESULT_MAXIMUM_AGE_MS,
  runSharedBaseSuite,
  sharedBaseResultsDirectory,
} from "./shared-base-suite.mjs";
import { SuiteSignalError } from "./suite-child-signal-forwarding.mjs";
import { parseTestItemDurationsMs } from "./suite-duration-gate.mjs";

const FINISHED_OUTPUT = [
  "✔ passes (5.1ms)",
  "✖ fails (7.2ms)",
  "ℹ tests 2",
  "ℹ pass 1",
  "ℹ fail 1",
  "ℹ cancelled 0",
  "",
  "✖ failing tests:",
  "",
  "test at scripts/example.test.ts:4:1",
  "✖ fails (7.2ms)",
  "  'expected the example to pass'",
  "run-suite-container: tests executed: 2",
  "",
].join("\n");

const TIMED_OUT_TEST_FILE_OUTPUT = [
  "✖ hangs forever (1002.395375ms)",
  "✔ passes (1.100667ms)",
  "ℹ tests 2",
  "ℹ pass 1",
  "ℹ fail 0",
  "ℹ cancelled 1",
  "",
  "✖ failing tests:",
  "",
  "test at hang.test.mjs:2:1",
  "✖ hangs forever (1002.395375ms)",
  "  'test timed out after 1000ms'",
  "run-suite-container: tests executed: 2",
  "",
].join("\n");

async function readKilledTestFileOutput() {
  const log = await readFile(new URL("../test/fixtures/spec-reporter-killed-test-file.log", import.meta.url), "utf8");
  return `${log}run-suite-container: tests executed: 2108\n`;
}

type SuiteRun = { status: number; output: string };

async function createBaseRepository(t: test.TestContext) {
  const baseDirectory = await initRepo("shared-base-suite-");
  const throneHome = await mkdtemp(path.join(tmpdir(), "shared-base-home-"));
  t.after(() => Promise.all([rm(baseDirectory, { recursive: true, force: true }), rm(throneHome, { recursive: true, force: true })]));
  await mkdir(path.join(baseDirectory, "scripts"));
  await writeFile(path.join(baseDirectory, "scripts", "run-suite.mjs"), 'import "./suite-guard.mjs";\n');
  await writeFile(path.join(baseDirectory, "scripts", "suite-guard.mjs"), "export {};\n");
  await writeFile(
    path.join(baseDirectory, "package.json"),
    JSON.stringify({ scripts: { test: "node scripts/run-suite.mjs -- npm run test:inner", "test:inner": "node --test" } }),
  );
  await commitAll(baseDirectory, "suite");
  return { baseDirectory, environment: { THRONE_DATA_HOME: throneHome } as NodeJS.ProcessEnv };
}

async function commitAll(directory: string, message: string) {
  await git(directory, ["add", "-A"]);
  await git(directory, ["commit", "--no-gpg-sign", "-m", message]);
}

function recordingSuite(run: () => Promise<SuiteRun> | SuiteRun = () => ({ status: 1, output: FINISHED_OUTPUT })) {
  const calls: string[][] = [];
  return {
    calls,
    runSuite: async (_baseDirectory: string, suiteCommand: string[]) => {
      calls.push(suiteCommand);
      return run();
    },
  };
}

function collectWrites() {
  const writes: string[] = [];
  return { writes, write: (text: string) => void writes.push(text) };
}

async function listResultFiles(environment: NodeJS.ProcessEnv) {
  try {
    return (await readdir(sharedBaseResultsDirectory(environment))).sort();
  } catch {
    return [];
  }
}

test("a base run for comparison reuses a finished result for the same base and says so", async (t) => {
  const { baseDirectory, environment } = await createBaseRepository(t);
  const suite = recordingSuite();
  const ranAt = new Date("2026-10-15T08:00:00.000Z");

  const firstExitCode = await runSharedBaseSuite({ baseDirectory, environment, runSuite: suite.runSuite, now: () => ranAt, write: () => {} });
  const second = collectWrites();
  const secondExitCode = await runSharedBaseSuite({ baseDirectory, environment, runSuite: suite.runSuite, write: second.write });

  const [resultFile] = await listResultFiles(environment);
  const resultPath = path.join(sharedBaseResultsDirectory(environment), resultFile);
  const key = resultFile.replace(/\.json$/, "");
  const saved = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(suite.calls.length, 1);
  assert.deepEqual(
    { exitCode: saved.exitCode, ranAt: saved.ranAt, output: saved.output, nonPassingTests: saved.nonPassingTests },
    { exitCode: 1, ranAt: ranAt.toISOString(), output: FINISHED_OUTPUT, nonPassingTests: ["fails"] },
  );
  assert.deepEqual(saved.testItems, parseTestItemDurationsMs(FINISHED_OUTPUT));
  assert.deepEqual(saved.testItems.slice(0, 2), [
    { name: "passes", durationMs: 5.1 },
    { name: "fails", durationMs: 7.2 },
  ]);
  assert.equal(firstExitCode, 1);
  assert.equal(secondExitCode, 1);
  assert.deepEqual(second.writes, [
    FINISHED_OUTPUT,
    `shared-base-suite: shared base result used: key=${key} ran_at=${ranAt.toISOString()} path=${resultPath}\n`,
  ]);
});

test("a different base tree, command, test group or suite script gives a different result file", async (t) => {
  const { baseDirectory, environment } = await createBaseRepository(t);
  const suite = recordingSuite();
  const run = (overrides: { suiteCommand?: string[]; environment?: NodeJS.ProcessEnv } = {}) =>
    runSharedBaseSuite({ baseDirectory, environment, runSuite: suite.runSuite, write: () => {}, ...overrides });

  await run();
  await writeFile(path.join(baseDirectory, "base.txt"), "another base\n");
  await commitAll(baseDirectory, "another base tree");
  await run();
  await run({ suiteCommand: ["npm", "test", "--", "--test-concurrency=1"] });
  await run({ environment: { ...environment, THRONE_SLOW_TESTS: "1" } });
  await writeFile(path.join(baseDirectory, "scripts", "suite-guard.mjs"), "export const changed = true;\n");
  await commitAll(baseDirectory, "another suite script");
  await run();

  assert.equal(suite.calls.length, 5);
  const resultFiles = await listResultFiles(environment);
  assert.equal(resultFiles.length, 5);
  const savedResults = await Promise.all(
    resultFiles.map(async (file) => JSON.parse(await readFile(path.join(sharedBaseResultsDirectory(environment), file), "utf8"))),
  );
  assert.equal(new Set(savedResults.map((saved) => saved.suiteScriptsHash)).size, 2);
});

test("an interrupted, refused or unfinished run saves no shared result", async (t) => {
  const { baseDirectory, environment } = await createBaseRepository(t);
  const unfinishedRuns: Array<() => SuiteRun> = [
    () => {
      throw new SuiteSignalError("SIGINT");
    },
    () => ({ status: 92, output: "suite-concurrency-guard: REFUSED, every slot is held\n" }),
    () => ({ status: 1, output: "✔ passes (5.1ms)\n" }),
    () => ({ status: 1, output: "run-suite-container: tests executed: unknown\n" }),
    () => ({ status: 3, output: "run-suite-container: tests executed: 0\n" }),
  ];

  const outcomes = [];
  for (const unfinishedRun of unfinishedRuns) {
    const suite = recordingSuite(unfinishedRun);
    outcomes.push(
      await runSharedBaseSuite({ baseDirectory, environment, runSuite: suite.runSuite, write: () => {} }).catch(
        (error: Error) => error.name,
      ),
    );
  }

  assert.deepEqual(outcomes, ["SuiteSignalError", 92, 1, 1, 3]);
  assert.deepEqual(await listResultFiles(environment), []);
});

test("a base run with a killed or timed-out test file is not saved as a shared result", async (t) => {
  const { baseDirectory, environment } = await createBaseRepository(t);
  const killedTestFileOutput = await readKilledTestFileOutput();
  const interruptedRuns: SuiteRun[] = [
    { status: 1, output: killedTestFileOutput },
    { status: 1, output: TIMED_OUT_TEST_FILE_OUTPUT },
  ];

  const exitCodes = [];
  const writes = collectWrites();
  for (const interruptedRun of interruptedRuns) {
    const suite = recordingSuite(() => interruptedRun);
    exitCodes.push(await runSharedBaseSuite({ baseDirectory, environment, runSuite: suite.runSuite, write: writes.write }));
  }

  assert.deepEqual(exitCodes, [1, 1]);
  assert.deepEqual(await listResultFiles(environment), []);
  assert.equal(writes.writes.filter((text) => text.includes("no shared base result was saved")).length, 2);
});

test("a saved base run records the name of every test that failed in it", async (t) => {
  const { baseDirectory, environment } = await createBaseRepository(t);
  const log = await readFile(new URL("../test/fixtures/spec-reporter-24-failing-tests.log", import.meta.url), "utf8");
  const suite = recordingSuite(() => ({ status: 1, output: `${log}run-suite-container: tests executed: 2113\n` }));

  await runSharedBaseSuite({ baseDirectory, environment, runSuite: suite.runSuite, write: () => {} });

  const [resultFile] = await listResultFiles(environment);
  const saved = JSON.parse(await readFile(path.join(sharedBaseResultsDirectory(environment), resultFile), "utf8"));
  assert.equal(saved.nonPassingTests.length, 24);
  assert.ok(saved.nonPassingTests.includes("every shipped skill is documented in docs/THRONE_SKILLS.md"));
});

test("two campaigns saving the same result at once both succeed without waiting for each other", async (t) => {
  const { baseDirectory, environment } = await createBaseRepository(t);
  let releaseBothRuns: () => void = () => {};
  const bothRunsStarted = new Promise<void>((resolve) => {
    releaseBothRuns = resolve;
  });
  let startedRuns = 0;
  const suite = recordingSuite(async () => {
    startedRuns += 1;
    if (startedRuns === 2) releaseBothRuns();
    await bothRunsStarted;
    return { status: 0, output: FINISHED_OUTPUT };
  });

  const exitCodes = await Promise.all([
    runSharedBaseSuite({ baseDirectory, environment, runSuite: suite.runSuite, write: () => {} }),
    runSharedBaseSuite({ baseDirectory, environment, runSuite: suite.runSuite, write: () => {} }),
  ]);

  assert.deepEqual(exitCodes, [0, 0]);
  assert.equal(suite.calls.length, 2);
  const files = await listResultFiles(environment);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{64}\.json$/);
});

test("shared results past the expiry rule are removed", async (t) => {
  const { baseDirectory, environment } = await createBaseRepository(t);
  const directory = sharedBaseResultsDirectory(environment);
  await mkdir(directory, { recursive: true });
  const now = new Date("2026-10-15T08:00:00.000Z");
  const expiredPath = path.join(directory, "expired.json");
  const keptPath = path.join(directory, "kept.json");
  await writeFile(expiredPath, "{}");
  await writeFile(keptPath, "{}");
  const expiredAt = new Date(now.getTime() - SHARED_BASE_RESULT_MAXIMUM_AGE_MS - 60_000);
  const keptAt = new Date(now.getTime() - SHARED_BASE_RESULT_MAXIMUM_AGE_MS + 60_000);
  await utimes(expiredPath, expiredAt, expiredAt);
  await utimes(keptPath, keptAt, keptAt);

  await runSharedBaseSuite({ baseDirectory, environment, runSuite: recordingSuite().runSuite, now: () => now, write: () => {} });

  const files = await listResultFiles(environment);
  assert.equal(files.length, 2);
  assert.ok(files.includes("kept.json"));
  assert.ok(!files.includes("expired.json"));
});

test("a base directory with uncommitted edits is refused and never saved under the clean tree's key", async (t) => {
  const { baseDirectory, environment } = await createBaseRepository(t);
  await writeFile(path.join(baseDirectory, "scripts", "suite-guard.mjs"), "export const edited = true;\n");
  await writeFile(path.join(baseDirectory, "untracked.test.ts"), "export {};\n");
  const suite = recordingSuite();
  const writes = collectWrites();

  const exitCode = await runSharedBaseSuite({ baseDirectory, environment, runSuite: suite.runSuite, write: writes.write });

  assert.equal(exitCode, 1);
  assert.equal(suite.calls.length, 0);
  assert.deepEqual(await listResultFiles(environment), []);
  assert.deepEqual(writes.writes, [
    `shared-base-suite: the base directory has uncommitted changes, so it is not a clean base and was not run: ${baseDirectory}\n`,
  ]);
});

test("a result file that another run removes while expired results are cleared does not stop the base run", async (t) => {
  const { baseDirectory, environment } = await createBaseRepository(t);
  const directory = sharedBaseResultsDirectory(environment);
  await mkdir(directory, { recursive: true });
  await symlink(path.join(directory, "already-removed.json"), path.join(directory, "removed-by-another-run.json"));
  const suite = recordingSuite();

  const exitCode = await runSharedBaseSuite({ baseDirectory, environment, runSuite: suite.runSuite, write: () => {} });

  assert.equal(exitCode, 1);
  assert.equal(suite.calls.length, 1);
});
