import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import {
  REAL_DEPS,
  run,
  type SummonDeps,
} from "./summon-regent-runtime.ts";

let configuredDependencies: SummonDeps | undefined;

export function configureSummonRegentDependencies(
  dependencies: SummonDeps,
): void {
  configuredDependencies = dependencies;
}

@Command({
  name: "summon-regent",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class SummonRegentCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await run(
      passedParams,
      configuredDependencies ?? REAL_DEPS,
    );
  }
}

