import type { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { run } from './campaign-evidence-runtime.ts';

@Command({
  name: 'campaign-evidence',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class CampaignEvidenceCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await run(passedParams);
  }
}

