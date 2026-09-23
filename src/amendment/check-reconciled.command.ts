import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { run } from "./check-reconciled-runtime.ts";

@Command({
  name: "check-queue-amendments-reconciled",
  description:
    "Exit 0 when an Alpha's plan records every amendment on its queue row as reconciled; exit 66 otherwise.",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class CheckQueueAmendmentsReconciledCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await run(passedParams);
  }
}
