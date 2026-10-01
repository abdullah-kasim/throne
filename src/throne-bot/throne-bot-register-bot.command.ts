import { Command, CommandRunner } from 'nest-commander';
import { registerBot } from './throne-bot-runtime.ts';
import { REAL_THRONE_BOT_DEPS } from './throne-bot-runtime-deps.ts';

@Command({ name: 'throne-bot-register-bot' })
export class ThroneBotRegisterBotCommand extends CommandRunner {
  async run(passedParams: string[]): Promise<void> {
    const [botName] = passedParams;
    if (botName === undefined) {
      process.stderr.write('Usage: throne-bot register-bot <bot>\n');
      process.exitCode = 1;
      return;
    }
    try {
      const credentials = await registerBot(REAL_THRONE_BOT_DEPS, botName);
      process.stdout.write(`${JSON.stringify(credentials)}\n`);
    } catch (error) {
      process.stderr.write(
        `throne-bot register-bot: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
