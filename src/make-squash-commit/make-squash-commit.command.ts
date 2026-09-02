import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { run } from './make-squash-commit-runtime.ts';

@Command({
  name: "make-squash-commit",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class MakeSquashCommitCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await run(passedParams);
  }
}
