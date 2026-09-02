import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner, Option } from "nest-commander";
import { DEFAULT_SUITE_ARBITRATION_LEDGER_PATH } from "./regent-fencing-paths.ts";
import { recordSuiteRelease } from "./suite-arbitration-ledger.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

interface RecordSuiteReleaseOptions {
  readonly campaign?: string;
}

let configuredLedgerPath = DEFAULT_SUITE_ARBITRATION_LEDGER_PATH;

/** Test seam: points the command at an isolated ledger path instead of the
 *  real durable one. Production never calls this. */
export function configureRecordSuiteReleaseLedgerPath(
  ledgerPath: string,
): void {
  configuredLedgerPath = ledgerPath;
}

@Command({
  name: "record-suite-release",
  description: "Records that a campaign has released full-suite access.",
})
export class RecordSuiteReleaseCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  @Option({
    flags: "--campaign <campaign>",
    description: "Campaign name releasing suite access.",
  })
  parseCampaign(value: string): string {
    return value;
  }

  async run(
    _passedParams: string[],
    options?: RecordSuiteReleaseOptions,
  ): Promise<void> {
    if (!options?.campaign) {
      console.error(
        `record-suite-release requires --campaign\n${renderEntranceRefusal({
          reason:
            "record-suite-release entrance validation requires --campaign.",
          bypass: undefined,
          supervisorRoute:
            "Ask your supervisor for an allowed alternative invocation.",
        })}`,
      );
      process.exitCode = 1;
      return;
    }
    await recordSuiteRelease(configuredLedgerPath, {
      campaign: options.campaign,
      recordedAt: new Date().toISOString(),
    });
    console.log(`recorded suite release for "${options.campaign}"`);
  }
}
