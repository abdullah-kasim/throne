import type { Command as CommanderCommand } from "commander";
import { Command } from "nest-commander";
import { OwnHelpCommandRunner } from "../shared-policy/own-help-command-runner.ts";
import { runSemaphore } from "./semaphore-runtime.ts";

interface ParsedProgram {
  readonly rawArgs?: readonly string[];
}

function argumentsAsTypedAfter(command: CommanderCommand): string[] {
  const typed = (command.parent as ParsedProgram | null)?.rawArgs ?? [];
  return typed.slice(typed.indexOf(command.name()) + 1);
}

@Command({
  name: "semaphore",
  description:
    "Create a named counting semaphore with a slot count, run a command in one of its free slots (waiting while every slot is held), or show who holds each slot.",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class SemaphoreCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(): Promise<number> {
    return runSemaphore(argumentsAsTypedAfter(this.command));
  }
}
