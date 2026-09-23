import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { run } from "./situation-brief-runtime.ts";

@Command({
  name: "situation-brief",
  description:
    "Print the launch situation for a queue row: its amendments, repository state, sibling work, open pull requests and cited commits.",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class SituationBriefCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await run(passedParams);
  }
}
