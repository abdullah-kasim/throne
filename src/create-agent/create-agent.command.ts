import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import type { CreateAgentDeps } from "./create.types.ts";
import { run, runCreateAgent } from "./create.ts";
import { CustomHarnessService } from "./custom-harness.service.ts";
import type { CreateAgentDeps as LegacyCreateAgentDeps } from "../create-agent-legacy/create.types.ts";
import {
  run as runLegacy,
  runCreateAgent as runLegacyCreateAgent,
} from "../create-agent-legacy/create.ts";
import { CustomHarnessService as LegacyCustomHarnessService } from "../create-agent-legacy/custom-harness.service.ts";
import { UsageReadersService } from "../shared-policy/usage-readers.service.ts";

let configuredDependencies: CreateAgentDeps | undefined;
let configuredLegacyDependencies: LegacyCreateAgentDeps | undefined;

export function configureCreateAgentCommandDependencies(
  dependencies: CreateAgentDeps | undefined,
): void {
  configuredDependencies = dependencies;
}

export function configureCreateAgentLegacyCommandDependencies(
  dependencies: LegacyCreateAgentDeps | undefined,
): void {
  configuredLegacyDependencies = dependencies;
}

@Command({
  name: "create-agent",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class CreateAgentCommand extends CommandRunner {
  private readonly customHarnessService: CustomHarnessService;
  private readonly usageReaders: UsageReadersService;

  constructor(
    customHarnessService: CustomHarnessService,
    usageReaders: UsageReadersService,
  ) {
    super();
    this.customHarnessService = customHarnessService;
    this.usageReaders = usageReaders;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode =
      configuredDependencies === undefined
        ? await run(passedParams, undefined, this.customHarnessService)
        : await runCreateAgent(passedParams, {
            ...configuredDependencies,
            customHarnessService: this.customHarnessService,
            nativeClaudeUsageReader: this.usageReaders.claude,
          });
  }
}

@Command({
  name: "create-agent-legacy",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class CreateAgentLegacyCommand extends CommandRunner {
  private readonly customHarnessService: LegacyCustomHarnessService;
  private readonly usageReaders: UsageReadersService;

  constructor(
    customHarnessService: LegacyCustomHarnessService,
    usageReaders: UsageReadersService,
  ) {
    super();
    this.customHarnessService = customHarnessService;
    this.usageReaders = usageReaders;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode =
      configuredLegacyDependencies === undefined
        ? await runLegacy(passedParams, undefined, this.customHarnessService)
        : await runLegacyCreateAgent(passedParams, {
            ...configuredLegacyDependencies,
            customHarnessService: this.customHarnessService,
            nativeClaudeUsageReader: this.usageReaders.claude,
          });
  }
}
