import type { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { runSweepTmpScratch } from './sweep-tmp-scratch-runtime.ts';

@Command({
  name: 'sweep-tmp-scratch',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class SweepTmpScratchCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runSweepTmpScratch(passedParams);
  }
}
