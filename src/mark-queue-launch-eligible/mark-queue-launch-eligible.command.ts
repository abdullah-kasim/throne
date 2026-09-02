import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { run } from "./mark-queue-launch-eligible-runtime.ts";

@Command({
  name: "mark-queue-launch-eligible",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class MarkQueueLaunchEligibleCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await run(passedParams);
  }
}
