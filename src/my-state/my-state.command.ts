import type { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { runMyState } from './my-state.ts';

@Command({
  name: 'my-state',
  description: 'Record your own state (working, blocked, waiting, reapable) in your state file.',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class MyStateCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runMyState(passedParams);
  }
}
