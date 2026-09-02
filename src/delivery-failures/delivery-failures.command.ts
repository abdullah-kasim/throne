import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { runDeliveryFailures, type DeliveryFailuresDeps } from "./delivery-failures.ts";

@Command({
  name: "delivery-failures",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class DeliveryFailuresCommand extends CommandRunner {
  private readonly deps: DeliveryFailuresDeps | undefined;

  constructor(deps?: DeliveryFailuresDeps) {
    super();
    this.deps = deps;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runDeliveryFailures(passedParams, this.deps);
  }
}
