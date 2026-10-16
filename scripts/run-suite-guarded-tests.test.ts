import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const guardedTestsRunner = path.join(scriptsDirectory, "run-suite-guarded-tests.mjs");

function printAndExit(text: string, status: number) {
  return [process.execPath, "-e", `console.log(${JSON.stringify(text)}); process.exit(${status});`];
}

function runGuardedTests(commandArguments: string[]) {
  return spawnSync(process.execPath, [guardedTestsRunner, ...commandArguments], { encoding: "utf8" });
}

test("a lint error in a file nobody changed still fails the run, after the tests", () => {
  const run = runGuardedTests([
    "--guard",
    ...printAndExit("full lint found an error", 1),
    "--test",
    ...printAndExit("the tests ran", 0),
  ]);

  assert.equal(run.status, 1);
  assert.ok(run.stdout.indexOf("the tests ran") < run.stdout.indexOf("full lint found an error"));

  const testIsolated = JSON.parse(readFileSync(path.join(scriptsDirectory, "..", "package.json"), "utf8")).scripts["test:isolated"];
  assert.match(testIsolated, /node scripts\/run-suite-guarded-tests\.mjs .*--guard npm run lint --test /);
  assert.equal(testIsolated.split("npm run lint ").length, 2);
});

test("a failing pre-guard stops the run before the tests", () => {
  const run = runGuardedTests([
    "--pre-guard",
    ...printAndExit("a pre-guard failed", 7),
    "--guard",
    ...printAndExit("a post-guard ran", 0),
    "--test",
    ...printAndExit("the tests ran", 0),
  ]);

  assert.equal(run.status, 7);
  assert.match(run.stdout, /a pre-guard failed/);
  assert.doesNotMatch(run.stdout, /the tests ran|a post-guard ran/);
});
