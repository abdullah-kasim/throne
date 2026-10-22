import { Command } from "nest-commander";
import { OwnHelpCommandRunner } from "../shared-policy/own-help-command-runner.ts";
import { runScratchPane } from "./scratch-pane.ts";

@Command({
  name: "scratch-pane",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class ScratchPaneCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(commandArguments: readonly string[]): Promise<number> {
    return runScratchPane(commandArguments);
  }
}
