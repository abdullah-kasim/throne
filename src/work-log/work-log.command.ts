import { Command } from "nest-commander";
import { OwnHelpCommandRunner } from "../shared-policy/own-help-command-runner.ts";
import { runWorkLog } from "./work-log-runtime.ts";

@Command({
  name: "work-log",
  description:
    "List the queue rows completed or updated since a date, with each row's recorded outcome and intent, and the GitHub actions logged since that date.",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class WorkLogCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(commandArguments: readonly string[]): Promise<number> {
    return runWorkLog(commandArguments);
  }
}
