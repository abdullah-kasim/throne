import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { runReadMessage } from "./read-message.ts";

@Command({ name: "read-message", allowUnknownOptions: true, allowExcessArgs: true })
export class ReadMessageCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(messageIdArguments: string[]): Promise<void> {
    process.exitCode = await runReadMessage(messageIdArguments);
  }
}
