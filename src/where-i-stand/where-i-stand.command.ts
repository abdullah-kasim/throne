import { Command } from "nest-commander";
import { OwnHelpCommandRunner } from "../shared-policy/own-help-command-runner.ts";
import { runWhereIStand } from "./where-i-stand-runtime.ts";

@Command({
  name: "where-i-stand",
  description:
    "List the Lord's where-i-stand tabs and sections with their ids and listing token, show the page as Markdown, put or archive a work entry, note an event, archive or restore a row or section, create a tab or section, and purge rows archived over six months. Reaches throne-backend; --local opens the database in this process.",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class WhereIStandCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(commandArguments: readonly string[]): Promise<number> {
    return runWhereIStand(commandArguments);
  }
}
