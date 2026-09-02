import { spawnSync } from "node:child_process";

function parseCommands(argumentsList) {
  const testIndex = argumentsList.indexOf("--test");
  if (testIndex === -1) {
    throw new Error("usage: run-suite-post-guards.mjs --guard <command...> --test <command...>");
  }

  const guardArguments = argumentsList.slice(0, testIndex);
  const guards = [];
  let guard = [];
  for (const argument of guardArguments) {
    if (argument === "--guard") {
      if (guard.length > 0) guards.push(guard);
      guard = [];
    } else {
      guard.push(argument);
    }
  }
  if (guard.length > 0) guards.push(guard);

  const testCommand = argumentsList.slice(testIndex + 1);
  if (guards.length === 0 || testCommand.length === 0) {
    throw new Error("usage: run-suite-post-guards.mjs --guard <command...> --test <command...>");
  }
  return { guards, testCommand };
}

function runCommand([command, ...argumentsList]) {
  const result = spawnSync(command, argumentsList, { env: process.env, stdio: "inherit" });
  if (result.error) {
    console.error(`run-suite-post-guards: failed to run ${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

const { guards, testCommand } = parseCommands(process.argv.slice(2));
const testStatus = runCommand(testCommand);
const guardStatuses = guards.map(runCommand);
const guardFailure = guardStatuses.find((status) => status !== 0) ?? 0;

process.exitCode = testStatus !== 0 ? testStatus : guardFailure;
