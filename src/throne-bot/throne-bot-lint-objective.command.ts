import { readFile } from 'node:fs/promises';
import type { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { lintObjectiveBody } from './lint-objective.ts';

@Command({
  name: 'throne-bot-lint-objective',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class ThroneBotLintObjectiveCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    const bodyFileFlagIndex = passedParams.indexOf('--body-file');
    const bodyFile =
      bodyFileFlagIndex === -1 ? undefined : passedParams[bodyFileFlagIndex + 1];
    if (bodyFile === undefined) {
      process.stderr.write('Usage: throne-bot lint-objective --body-file <path>\n');
      process.exitCode = 1;
      return;
    }
    try {
      const body = await readFile(bodyFile, 'utf8');
      const result = lintObjectiveBody(body);
      if (!result.ok) {
        process.stderr.write(`throne-bot lint-objective: ${result.reason}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write('throne-bot lint-objective: ok\n');
    } catch (error) {
      process.stderr.write(
        `throne-bot lint-objective: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
