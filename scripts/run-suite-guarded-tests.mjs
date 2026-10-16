import { spawnSync } from "node:child_process";
import { SuitePhase, formatPhaseStartMark } from "./suite-phase-timings.mjs";

const USAGE = "usage: run-suite-guarded-tests.mjs [--pre-guard <command...>] --guard <command...> --test <command...>";
const COMMAND_LIST_FLAGS = { "--pre-guard": "preGuards", "--guard": "guards" };

function parseCommands(argumentsList) {
  const testIndex = argumentsList.indexOf("--test");
  if (testIndex === -1) throw new Error(USAGE);

  const commands = { preGuards: [], guards: [] };
  let command;
  for (const argument of argumentsList.slice(0, testIndex)) {
    if (argument in COMMAND_LIST_FLAGS) {
      command = [];
      commands[COMMAND_LIST_FLAGS[argument]].push(command);
    } else if (command) {
      command.push(argument);
    } else {
      throw new Error(USAGE);
    }
  }

  const testCommand = argumentsList.slice(testIndex + 1);
  const everyCommandIsNamed = [...commands.preGuards, ...commands.guards].every((listed) => listed.length > 0);
  if (commands.guards.length === 0 || testCommand.length === 0 || !everyCommandIsNamed) {
    throw new Error(USAGE);
  }
  return { ...commands, testCommand };
}

function runCommand([command, ...argumentsList]) {
  const result = spawnSync(command, argumentsList, { env: process.env, stdio: "inherit" });
  if (result.error) {
    console.error(`run-suite-guarded-tests: failed to run ${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function runUntilOneFails(commands) {
  for (const command of commands) {
    const status = runCommand(command);
    if (status !== 0) return status;
  }
  return 0;
}

const { preGuards, guards, testCommand } = parseCommands(process.argv.slice(2));
process.stdout.write(formatPhaseStartMark(SuitePhase.GUARDS));
const preGuardFailure = runUntilOneFails(preGuards);
if (preGuardFailure !== 0) process.exit(preGuardFailure);
process.stdout.write(formatPhaseStartMark(SuitePhase.TESTS));
const testStatus = runCommand(testCommand);
process.stdout.write(formatPhaseStartMark(SuitePhase.POST_GUARDS));
const guardStatuses = guards.map(runCommand);
const guardFailure = guardStatuses.find((status) => status !== 0) ?? 0;

process.exitCode = testStatus !== 0 ? testStatus : guardFailure;
