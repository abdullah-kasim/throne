import type { Command as CommanderCommand } from 'commander';
import { CommandRunner } from 'nest-commander';

export abstract class OwnHelpCommandRunner extends CommandRunner {
  override setCommand(commanderCommand: CommanderCommand): this {
    super.setCommand(commanderCommand);
    commanderCommand.helpOption(false);
    return this;
  }

  async run(commandArguments: string[]): Promise<void> {
    process.exitCode = await this.exitCodeOf(commandArguments);
  }

  protected abstract exitCodeOf(commandArguments: readonly string[]): Promise<number>;
}
