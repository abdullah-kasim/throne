import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { run } from "./check-main-integrity-runtime.ts";

@Command({
  name: "check-main-integrity",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class CheckMainIntegrityCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await run(passedParams);
  }
}
