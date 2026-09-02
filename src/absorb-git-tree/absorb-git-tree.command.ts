import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { run } from "./absorb-git-tree-runtime.ts";

@Command({
  name: "absorb-git-tree",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class AbsorbGitTreeCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await run(passedParams);
  }
}
