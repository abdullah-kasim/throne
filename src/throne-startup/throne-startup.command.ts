import { Inject, Injectable } from "@nestjs/common";
import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { ThroneStartupService } from "./throne-startup.service.ts";

@Injectable()
@Command({
  name: "throne-startup",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class ThroneStartupCommand extends CommandRunner {
  private readonly startup: ThroneStartupService;

  constructor(@Inject(ThroneStartupService) startup: ThroneStartupService) {
    super();
    this.startup = startup;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await this.startup.run(passedParams);
  }
}
