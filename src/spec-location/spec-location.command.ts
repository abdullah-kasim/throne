import { Command } from "nest-commander";
import { OwnHelpCommandRunner } from "../shared-policy/own-help-command-runner.ts";
import { runSpecLocation } from "./run-spec-location.ts";

@Command({
  name: "spec-location",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class SpecLocationCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(commandArguments: readonly string[]): Promise<number> {
    return runSpecLocation(commandArguments, {
      environment: process.env,
      writeStdout: (text) => process.stdout.write(text),
      writeStderr: (text) => process.stderr.write(text),
    });
  }
}
