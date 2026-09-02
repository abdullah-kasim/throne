import { Injectable, Inject } from "@nestjs/common";
import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { type Deps as CodexUsageDeps } from "../shared-policy/codex-usage.service.ts";
import { UsageAdaptersService } from "../shared-policy/usage-adapters.service.ts";

export type { CodexUsageDeps };

export class CodexUsageDependenciesService {
  readonly dependencies: CodexUsageDeps;

  constructor(dependencies: CodexUsageDeps) {
    this.dependencies = dependencies;
  }
}

@Command({
  name: "codex-usage-remaining",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
@Injectable()
export class CodexUsageRemainingCommand extends CommandRunner {
  private readonly adapters: UsageAdaptersService;
  private readonly dependencies: CodexUsageDeps;

  constructor(
    @Inject(UsageAdaptersService) adapters: UsageAdaptersService,
    @Inject(CodexUsageDependenciesService)
    dependencies: CodexUsageDependenciesService,
  ) {
    super();
    this.adapters = adapters;
    this.dependencies = dependencies.dependencies;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await this.adapters.runCodexUsage(
      passedParams,
      this.dependencies,
    );
  }
}
