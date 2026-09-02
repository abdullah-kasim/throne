import type { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';

import { run } from './switch-agent-model.command-runtime.ts';

@Command({
  name: 'switch-agent-model',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class SwitchAgentModelCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await run(passedParams);
  }
}

