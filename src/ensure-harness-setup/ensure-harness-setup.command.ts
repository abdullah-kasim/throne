import type { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { runEnsureHarnessSetup } from './ensure-harness-setup.ts';

@Command({
  name: 'ensure-harness-setup',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class EnsureHarnessSetupCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runEnsureHarnessSetup(passedParams);
  }
}
