import { Command } from "nest-commander";
import { OwnHelpCommandRunner } from "../shared-policy/own-help-command-runner.ts";
import { runMigrateHome } from "./migrate-home-runtime.ts";

@Command({
  name: "migrate-home",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class MigrateHomeCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(commandArguments: readonly string[]): Promise<number> {
    return runMigrateHome(commandArguments);
  }
}
