// The Nest CommandRunner wrapper for `keep-going`. The actual sweep logic
// (the Regent heartbeat/resurrect/nudge state machine) lives in
// keep-going-sweep.ts; the REST route + transport-triggering CLI helper live
// in keep-going-route.ts. Split three ways to keep every file under the
// hand-authored 500-line limit (test/nest-commander-boundary.test.ts)
// without introducing an import cycle: this file depends on both of the
// others, neither of which depends back on this one. Re-exports the sweep
// module's public surface so every existing `from './keep-going.command.ts'`
// import keeps working unchanged.
import { Optional } from '@nestjs/common';
import { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { TransportClient } from '../transport/transport-client.ts';
import { resolveTransportMode } from '../transport/resolve-transport-mode.ts';
import { run } from './keep-going-sweep.ts';
import { parseKeepGoingArgs, runKeepGoingOverTransport } from './keep-going-route.ts';

export * from './keep-going-sweep.ts';

@Command({
  name: 'keep-going',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class KeepGoingCommand extends CommandRunner {
  private readonly transportClient: TransportClient;

  constructor(@Optional() transportClient?: TransportClient) {
    super();
    this.transportClient = transportClient ?? new TransportClient();
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    const { transport, local, remainingArgs } = parseKeepGoingArgs(passedParams);
    const mode = resolveTransportMode({ transport, local }, 'keep-going');
    process.exitCode =
      mode === 'rest'
        ? await runKeepGoingOverTransport(this.transportClient, remainingArgs)
        : await run(remainingArgs);
    // Printed on every manual invocation (both --local and --transport rest)
    // -- see KEEP_GOING_ROUTE_PATH's doc comment (keep-going-route.ts) for
    // the full reasoning. This command deliberately never touches
    // runOnce()'s watchdog wrapper, so it cannot prove that wrapper's own
    // failure-tolerance logic works, only that the underlying sweep does.
    process.stdout.write(
      'keep-going: NOTE — this manual trigger bypasses runOnce()\'s watchdog/' +
        'consecutive-failure wrapper; it proves the SWEEP works, not that the ' +
        "scheduler's own failure-tolerance logic is intact. Only the scheduled cron tick exercises that.\n",
    );
  }
}
