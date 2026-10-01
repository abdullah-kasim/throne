import { Command, CommandRunner } from 'nest-commander';
import { sayToBot } from './throne-bot-runtime.ts';
import { REAL_THRONE_BOT_DEPS } from './throne-bot-runtime-deps.ts';

@Command({ name: 'throne-bot-say' })
export class ThroneBotSayCommand extends CommandRunner {
  async run(passedParams: string[]): Promise<void> {
    const [botName, text] = passedParams;
    if (botName === undefined || text === undefined) {
      process.stderr.write('Usage: throne-bot say <bot> <text>\n');
      process.exitCode = 1;
      return;
    }
    try {
      const eventId = await sayToBot(REAL_THRONE_BOT_DEPS, botName, text);
      process.stdout.write(`${eventId}\n`);
    } catch (error) {
      process.stderr.write(
        `throne-bot say: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
