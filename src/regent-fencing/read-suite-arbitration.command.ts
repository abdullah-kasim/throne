import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { DEFAULT_SUITE_ARBITRATION_LEDGER_PATH } from "./regent-fencing-paths.ts";
import { readSuiteArbitrationState } from "./suite-arbitration-ledger.ts";

let configuredLedgerPath = DEFAULT_SUITE_ARBITRATION_LEDGER_PATH;

/** Test seam: points the command at an isolated ledger path instead of the
 *  real durable one. Production never calls this. */
export function configureReadSuiteArbitrationLedgerPath(ledgerPath: string): void {
  configuredLedgerPath = ledgerPath;
}

@Command({
  name: "read-suite-arbitration",
  description: "Prints the campaigns currently holding full-suite access.",
})
export class ReadSuiteArbitrationCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(): Promise<void> {
    const result = await readSuiteArbitrationState(configuredLedgerPath);
    if (result.state === "unknown") {
      console.error(`suite-arbitration state unknown: ${result.reason}`);
      process.exitCode = 1;
      return;
    }
    if (result.heldCampaigns.length === 0) {
      console.log("no campaign currently holds full-suite access");
      return;
    }
    for (const held of result.heldCampaigns) {
      console.log(`${held.campaign}: held since ${held.recordedAt} (${held.reason})`);
    }
  }
}
