import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import {
  REAL_DEPS,
  run,
  type DismissDeps,
} from "./dismiss-regent-runtime.ts";

let configuredDependencies: DismissDeps | undefined;

export function configureDismissRegentDependencies(
  dependencies: DismissDeps,
): void {
  configuredDependencies = dependencies;
}

@Command({
  name: "dismiss-regent",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class DismissRegentCommand extends CommandRunner {
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

