import type { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { runMcq } from './mcq-runtime.ts';

@Command({
  name: 'mcq',
  description:
    'Answer or dismiss the interactive prompt held up in a named agent\'s pane; Regent or Stager only.',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class McqCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runMcq(passedParams);
  }
}
