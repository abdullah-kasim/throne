import { Command } from "nest-commander";
import { resolveCurrentAgentName } from "../herdr/herdr-session.service.ts";
import { OwnHelpCommandRunner } from "../shared-policy/own-help-command-runner.ts";
import { waitForStopOrTimeout } from "./folder-lock.ts";
import { runSpecLock } from "./run-spec-lock.ts";

@Command({
  name: "spec-lock",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class SpecLockCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(commandArguments: readonly string[]): Promise<number> {
    return runSpecLock(commandArguments, {
      environment: process.env,
      processId: process.pid,
      now: () => new Date(),
      currentAgentName: resolveCurrentAgentName,
      waitForRelease: waitForStopOrTimeout,
      writeStdout: (text) => process.stdout.write(text),
      writeStderr: (text) => process.stderr.write(text),
    });
  }
}
