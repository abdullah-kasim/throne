import { Command, CommandRunner } from 'nest-commander';
import { sendFileToBot } from './throne-bot-runtime.ts';
import { REAL_THRONE_BOT_DEPS } from './throne-bot-runtime-deps.ts';

@Command({ name: 'throne-bot-send-file' })
export class ThroneBotSendFileCommand extends CommandRunner {
  async run(passedParams: string[]): Promise<void> {
    const [botName, filePath] = passedParams;
    if (botName === undefined || filePath === undefined) {
      process.stderr.write('Usage: throne-bot send-file <bot> <path>\n');
      process.exitCode = 1;
      return;
    }
    try {
      const eventId = await sendFileToBot(REAL_THRONE_BOT_DEPS, botName, filePath);
      process.stdout.write(`${eventId}\n`);
    } catch (error) {
      process.stderr.write(
        `throne-bot send-file: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
