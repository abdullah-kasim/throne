import { Command } from "nest-commander";
import { OwnHelpCommandRunner } from "../shared-policy/own-help-command-runner.ts";
import { runCheckWhereIStand } from "./check-where-i-stand-runtime.ts";

@Command({
  name: "check-where-i-stand",
  description:
    "Exit 0 when an Alpha's campaign recorded its outcome on the Lord's where-i-stand page after it delivered; exit 66 with one sentence saying what to write otherwise.",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class CheckWhereIStandCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(commandArguments: readonly string[]): Promise<number> {
    return runCheckWhereIStand(commandArguments);
  }
}
