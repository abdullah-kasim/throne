import { Command } from "nest-commander";
import { OwnHelpCommandRunner } from "../shared-policy/own-help-command-runner.ts";
import { run } from "./push-waiver-runtime.ts";

@Command({
  name: "push-waiver",
  description:
    "Record why every finding the push checks reported is not a defect in the pushed branch, so that one commit may be pushed to one branch once without the checks.",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class PushWaiverCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(commandArguments: readonly string[]): Promise<number> {
    return run(commandArguments);
  }
}
