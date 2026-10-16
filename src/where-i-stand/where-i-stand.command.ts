import { Command } from "nest-commander";
import { OwnHelpCommandRunner } from "../shared-policy/own-help-command-runner.ts";
import { runWhereIStand } from "./where-i-stand-runtime.ts";

@Command({
  name: "where-i-stand",
  description:
    "Show the Lord's where-i-stand page with its path and checksum, hold its advisory edit lock in the background while you edit the page with your own edit tool, or add one event to its Just happened list. Every edit is journaled when the lock is released.",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class WhereIStandCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(commandArguments: readonly string[]): Promise<number> {
    return runWhereIStand(commandArguments);
  }
}
