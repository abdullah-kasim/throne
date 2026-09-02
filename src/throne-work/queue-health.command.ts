import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import {
  QUEUE_HEALTH_EXIT_CODE,
  formatQueueHealthOutput,
  runQueueHealthCheck,
  type QueueHealthCheckDeps,
} from "./queue-health.ts";

@Command({
  name: "queue-health",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class QueueHealthCommand extends CommandRunner {
  private readonly deps: QueueHealthCheckDeps | undefined;

  constructor(deps?: QueueHealthCheckDeps) {
    super();
    this.deps = deps;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(): Promise<void> {
    const { verdict, lastRetentionSweep } = await runQueueHealthCheck(this.deps);
    process.stdout.write(formatQueueHealthOutput(verdict, lastRetentionSweep));
    process.exitCode = QUEUE_HEALTH_EXIT_CODE[verdict];
  }
}
