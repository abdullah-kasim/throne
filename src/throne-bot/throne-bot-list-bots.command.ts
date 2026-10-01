import { Command, CommandRunner } from 'nest-commander';
import { listRegisteredBots } from './throne-bot-runtime.ts';
import { REAL_THRONE_BOT_DEPS } from './throne-bot-runtime-deps.ts';

@Command({ name: 'throne-bot-list-bots' })
export class ThroneBotListBotsCommand extends CommandRunner {
  async run(): Promise<void> {
    try {
      const listings = await listRegisteredBots(REAL_THRONE_BOT_DEPS);
      for (const listing of listings) {
        process.stdout.write(
          `${listing.name}\t${listing.registered ? 'registered' : 'not-registered'}\n`,
        );
      }
    } catch (error) {
      process.stderr.write(
        `throne-bot list-bots: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
