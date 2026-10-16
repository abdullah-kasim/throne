#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveThroneHome } from "../src/shared-policy/throne-home.ts";
import { parseFailingTests, parseSuiteFailCancelledCounts } from "./check-known-failures.mjs";
import { describeSharedBaseRun, hasUncommittedChanges, sharedBaseResultKey } from "./shared-base-suite-key.mjs";
import { findSuiteSignal, runChildWithSignalForwarding } from "./suite-child-signal-forwarding.mjs";
import { parseTestItemDurationsMs } from "./suite-duration-gate.mjs";
import { formatTestsExecutedLine } from "./suite-test-verdict.mjs";

export const SHARED_BASE_RESULT_MAXIMUM_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SHARED_BASE_RESULTS_FOLDER_NAME = "shared-base-suite-results";
const DEFAULT_SUITE_COMMAND = ["npm", "test"];
const TESTS_EXECUTED_LINE = new RegExp(`^${formatTestsExecutedLine("").trim()} (\\d+)$`, "m");

export function sharedBaseResultsDirectory(environment = process.env) {
  return path.join(resolveThroneHome(environment), SHARED_BASE_RESULTS_FOLDER_NAME);
}

export function sharedBaseResultPath(directory, key) {
  return path.join(directory, `${key}.json`);
}

function isWholeTestFileFailure(failingTest) {
  return failingTest.name === failingTest.file;
}

function hasKilledOrTimedOutTestFile(output) {
  const { cancelled } = parseSuiteFailCancelledCounts(output);
  return (cancelled ?? 0) > 0 || parseFailingTests(output).some(isWholeTestFileFailure);
}

export function isCompleteSuiteRun(output) {
  const executed = output.match(TESTS_EXECUTED_LINE);
  return executed !== null && Number(executed[1]) > 0 && !hasKilledOrTimedOutTestFile(output);
}

export function readSharedBaseResult(resultPath) {
  try {
    return JSON.parse(readFileSync(resultPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function saveSharedBaseResult(resultPath, result) {
  mkdirSync(path.dirname(resultPath), { recursive: true });
  const temporaryPath = `${resultPath}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(result));
  renameSync(temporaryPath, resultPath);
}

export function removeExpiredSharedBaseResults(directory, nowMs) {
  let names;
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const file = path.join(directory, name);
    const fileStatus = statSync(file, { throwIfNoEntry: false });
    if (fileStatus && nowMs - fileStatus.mtimeMs > SHARED_BASE_RESULT_MAXIMUM_AGE_MS) rmSync(file, { force: true });
  }
}

export async function runBaseSuite(baseDirectory, suiteCommand) {
  let output = "";
  const status = await runChildWithSignalForwarding(suiteCommand[0], suiteCommand.slice(1), {
    cwd: baseDirectory,
    onOutput: (chunk) => {
      output += chunk;
    },
  });
  return { status, output };
}

function formatSharedResultUsedLine(key, result, resultPath) {
  return `shared-base-suite: shared base result used: key=${key} ran_at=${result.ranAt} path=${resultPath}\n`;
}

export async function runSharedBaseSuite({
  baseDirectory,
  suiteCommand = DEFAULT_SUITE_COMMAND,
  environment = process.env,
  runSuite = runBaseSuite,
  now = () => new Date(),
  write = (text) => process.stdout.write(text),
}) {
  if (hasUncommittedChanges(baseDirectory)) {
    write(`shared-base-suite: the base directory has uncommitted changes, so it is not a clean base and was not run: ${baseDirectory}\n`);
    return 1;
  }
  const directory = sharedBaseResultsDirectory(environment);
  removeExpiredSharedBaseResults(directory, now().getTime());
  const keyParts = describeSharedBaseRun(baseDirectory, suiteCommand, environment);
  const key = sharedBaseResultKey(keyParts);
  const resultPath = sharedBaseResultPath(directory, key);
  const shared = readSharedBaseResult(resultPath);
  if (shared) {
    write(shared.output);
    write(formatSharedResultUsedLine(key, shared, resultPath));
    return shared.exitCode;
  }
  const ranAt = now().toISOString();
  const { status, output } = await runSuite(baseDirectory, suiteCommand);
  if (!isCompleteSuiteRun(output)) {
    write(`shared-base-suite: the run did not finish, so no shared base result was saved: key=${key}\n`);
    return status;
  }
  saveSharedBaseResult(resultPath, {
    key,
    ...keyParts,
    ranAt,
    exitCode: status,
    output,
    testItems: parseTestItemDurationsMs(output),
    nonPassingTests: parseFailingTests(output).map((failingTest) => failingTest.name),
  });
  write(`shared-base-suite: shared base result saved: key=${key} path=${resultPath}\n`);
  return status;
}

function parseArguments(argv) {
  const separatorIndex = argv.indexOf("--");
  const positional = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const suiteCommand = separatorIndex === -1 ? DEFAULT_SUITE_COMMAND : argv.slice(separatorIndex + 1);
  if (positional.length !== 1 || suiteCommand.length === 0) {
    throw new Error("usage: shared-base-suite.mjs <base-directory> [-- <suite command...>]");
  }
  return { baseDirectory: path.resolve(positional[0]), suiteCommand };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runSharedBaseSuite(parseArguments(process.argv.slice(2)))
    .then((exitCode) => process.exit(exitCode))
    .catch((error) => {
      console.error(error);
      const signal = findSuiteSignal(error);
      if (signal) process.kill(process.pid, signal);
      else process.exit(1);
    });
}
