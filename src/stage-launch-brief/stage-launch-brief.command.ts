import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { runStageLaunchBrief } from "./stage-launch-brief-runtime.ts";

@Command({ name: "stage-launch-brief", allowUnknownOptions: true, allowExcessArgs: true })
export class StageLaunchBriefCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this { super.setCommand(command); command.helpOption(false); return this; }
  async run(passedParams: string[]): Promise<void> { process.exitCode = await runStageLaunchBrief(passedParams); }
}
