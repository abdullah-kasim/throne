import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import {
  REAL_DEPS,
  resultLine,
  verifyDeliveryPath,
  type VerifyDeliveryPathDeps,
} from "../message-queue/verify-delivery-path.command.ts";
import { ALPHA_FLOOR_CRON_SENDER } from "./alpha-floor-sender.ts";

/**
 * The same SQLite probe `verify-delivery-path` runs, with the sender alone
 * swapped to the Alpha-floor notifier's cron-owned identity. The recipient
 * remains the invoking session's pane-resolvable agent.
 */
export function buildAlphaFloorDeliveryProbeDeps(
  overrides: Partial<VerifyDeliveryPathDeps> = {},
): VerifyDeliveryPathDeps {
  return {
    ...REAL_DEPS,
    resolveSenderName: async () => ALPHA_FLOOR_CRON_SENDER,
    ...overrides,
  };
}

@Command({
  name: "verify-alpha-floor-delivery",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class VerifyAlphaFloorDeliveryCommand extends CommandRunner {
  private readonly deps: VerifyDeliveryPathDeps | undefined;

  constructor(deps?: VerifyDeliveryPathDeps) {
    super();
    this.deps = deps;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(): Promise<void> {
    const result = await verifyDeliveryPath(this.deps ?? buildAlphaFloorDeliveryProbeDeps());
    process.stdout.write(resultLine(result));
    process.exitCode = result.passed ? 0 : 1;
  }
}
