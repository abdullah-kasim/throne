import { Command } from "nest-commander";
import { OwnHelpCommandRunner } from "../shared-policy/own-help-command-runner.ts";
import { runSkillExtension } from "./skill-extension.ts";

@Command({
  name: "skill-extension",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class SkillExtensionCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(commandArguments: readonly string[]): Promise<number> {
    return runSkillExtension(commandArguments);
  }
}
