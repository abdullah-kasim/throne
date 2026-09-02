import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { runReclaimAgentScratchpads } from "./reclaim-agent-scratchpads-runtime.ts";

@Command({
  name: "reclaim-agent-scratchpads",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class ReclaimAgentScratchpadsCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runReclaimAgentScratchpads(passedParams);
  }
}
