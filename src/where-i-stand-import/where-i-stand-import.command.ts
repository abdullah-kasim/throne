import { Command } from "nest-commander";
import { OwnHelpCommandRunner } from "../shared-policy/own-help-command-runner.ts";
import { runWhereIStandImport } from "./where-i-stand-import-runtime.ts";

@Command({
  name: "where-i-stand-import",
  description:
    "Import today's Markdown where-i-stand page and its archive file into the where-i-stand database once, reading the files without changing them, or compare the database with a Markdown page.",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class WhereIStandImportCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(commandArguments: readonly string[]): Promise<number> {
    return runWhereIStandImport(commandArguments);
  }
}
