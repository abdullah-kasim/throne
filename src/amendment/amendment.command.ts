import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { run } from "./amendment-runtime.ts";

@Command({
  name: "amendment",
  description:
    "Record the Lord's amendment on a queue row and tell that row's Alpha and the Regent; refuses rows already delivered.",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class AmendmentCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await run(passedParams);
  }
}
