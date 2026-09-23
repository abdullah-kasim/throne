import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import {
  REAL_DEPS,
  run,
  type RestartHarnessesDeps,
} from "./restart-harnesses-runtime.ts";

let configuredDependencies: RestartHarnessesDeps | undefined;

export function configureRestartHarnessesDependencies(
  dependencies: RestartHarnessesDeps,
): void {
  configuredDependencies = dependencies;
}

@Command({
  name: "restart-harnesses",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class RestartHarnessesCommand extends CommandRunner {
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
