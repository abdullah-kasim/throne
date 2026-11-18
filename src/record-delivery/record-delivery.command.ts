import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { run } from "./record-delivery-runtime.ts";

@Command({
  name: "record-delivery",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class RecordDeliveryCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await run(passedParams);
  }
}
