import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner, Option } from "nest-commander";
import { DEFAULT_SUITE_ARBITRATION_LEDGER_PATH } from "./regent-fencing-paths.ts";
import { recordSuiteHold } from "./suite-arbitration-ledger.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

interface RecordSuiteHoldOptions {
  readonly campaign?: string;
  readonly reason?: string;
}

let configuredLedgerPath = DEFAULT_SUITE_ARBITRATION_LEDGER_PATH;

/** Test seam: points the command at an isolated ledger path instead of the
 *  real durable one. Production never calls this. */
export function configureRecordSuiteHoldLedgerPath(ledgerPath: string): void {
  configuredLedgerPath = ledgerPath;
}

@Command({
  name: "record-suite-hold",
  description:
    "Records that a campaign now holds full-suite access, so a fenced Regent's successor can " +
    "learn who was mid-sequence.",
})
export class RecordSuiteHoldCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  @Option({
    flags: "--campaign <campaign>",
    description: "Campaign name holding suite access.",
  })
  parseCampaign(value: string): string {
    return value;
  }

  @Option({
    flags: "--reason <reason>",
    description: "Why the campaign holds suite access.",
  })
  parseReason(value: string): string {
    return value;
  }

  async run(
    _passedParams: string[],
    options?: RecordSuiteHoldOptions,
  ): Promise<void> {
    if (!options?.campaign || !options.reason) {
      console.error(
        `record-suite-hold requires --campaign and --reason\n${renderEntranceRefusal(
          {
            reason:
              "record-suite-hold entrance validation requires both --campaign and --reason.",
            bypass: undefined,
            supervisorRoute:
              "Ask your supervisor for an allowed alternative invocation.",
          },
        )}`,
      );
      process.exitCode = 1;
      return;
    }
    await recordSuiteHold(configuredLedgerPath, {
      campaign: options.campaign,
      reason: options.reason,
      recordedAt: new Date().toISOString(),
    });
    console.log(`recorded suite hold for "${options.campaign}"`);
  }
}
