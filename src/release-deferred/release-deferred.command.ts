import { Command } from "nest-commander";
import { OwnHelpCommandRunner } from "../shared-policy/own-help-command-runner.ts";
import { run } from "./release-deferred-runtime.ts";

@Command({
  name: "release-deferred",
  description:
    "Release a deferred queue row to open, record who asked, who released it and why, and reply to the requester. Regent, or the Stager that filed the row.",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class ReleaseDeferredCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(commandArguments: readonly string[]): Promise<number> {
    return run([...commandArguments]);
  }
}
