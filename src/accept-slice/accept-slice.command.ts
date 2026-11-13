import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { run } from "./accept-slice-runtime.ts";

@Command({
  name: "accept-slice",
  description:
    "Accept a no-merge Shadow's slice: record the acceptance and send it the go-ahead to publish its reapability claim.",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class AcceptSliceCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await run(passedParams);
  }
}
