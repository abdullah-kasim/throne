import { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { PlanUsageRemainingService } from './plan-usage-remaining.service.ts';
import { PlanUsagePresentationService } from './plan-usage-presentation.service.ts';
import { planUsageCommandResult } from './plan-usage-accounts.ts';

@Command({
  name: 'plan-usage-remaining',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class PlanUsageRemainingCommand extends CommandRunner {
  private readonly usage: PlanUsageRemainingService;
  private readonly presentation: PlanUsagePresentationService;

  constructor(
    usage: PlanUsageRemainingService,
    presentation: PlanUsagePresentationService,
  ) {
    super();
    this.usage = usage;
    this.presentation = presentation;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    const result = await planUsageCommandResult(passedParams, this.usage, this.presentation);
    if (result.stdout !== undefined) process.stdout.write(result.stdout);
    if (result.stderr !== undefined) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  }
}

