import type { Command as CommanderCommand } from "commander";
import { Injectable } from "@nestjs/common";
import { Command, CommandRunner } from "nest-commander";
import {
  productionSwitchPersonaDeps,
  runSwitchPersona,
} from "./switch-persona.service.ts";

@Command({
  name: "switch-persona",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
@Injectable()
export class SwitchPersonaCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runSwitchPersona(
      passedParams,
      productionSwitchPersonaDeps(),
    );
  }
}
