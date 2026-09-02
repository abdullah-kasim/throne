import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import {
  type OpenCodeGoUsageDeps,
  OpenCodeGoUsageService,
} from "./opencode-go-usage.service.ts";


let configuredDependencies: OpenCodeGoUsageDeps | undefined;

export function configureOpenCodeGoUsageDependencies(
  dependencies: OpenCodeGoUsageDeps,
): void {
  configuredDependencies = dependencies;
}

@Command({
  name: "opencode-go-usage-remaining",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class OpenCodeGoUsageRemainingCommand extends CommandRunner {
  private readonly usage: OpenCodeGoUsageService;

  constructor(usage = new OpenCodeGoUsageService()) {
    super();
    this.usage = usage;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await this.usage.run(
      passedParams,
      configuredDependencies,
    );
  }
}
