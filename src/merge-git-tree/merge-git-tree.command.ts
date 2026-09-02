import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { run } from './merge-git-tree-runtime.ts';

@Command({
  name: "merge-git-tree",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class MergeGitTreeCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await run(passedParams, {
      err: (text) => this.writeStderr(text),
    });
  }

  protected writeStderr(text: string): void {
    process.stderr.write(text);
  }
}
