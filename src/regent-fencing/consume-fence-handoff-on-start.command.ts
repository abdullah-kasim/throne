import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { DEFAULT_FENCE_HANDOFF_RECORD_PATH } from "./regent-fencing-paths.ts";
import { consumeFenceHandoffOnStart } from "./consume-fence-handoff-on-start.ts";

let configuredRecordPath = DEFAULT_FENCE_HANDOFF_RECORD_PATH;

/** Test seam: points the command at an isolated handoff-record path instead
 *  of the real durable one. Production never calls this. */
export function configureConsumeFenceHandoffOnStartRecordPath(recordPath: string): void {
  configuredRecordPath = recordPath;
}

@Command({
  name: "consume-fence-handoff-on-start",
  description:
    "Reads and clears the current fence handoff record, so a freshly-summoned Regent learns " +
    "why its predecessor was fenced before it processes any pane message.",
})
export class ConsumeFenceHandoffOnStartCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(): Promise<void> {
    const record = await consumeFenceHandoffOnStart(configuredRecordPath);
    if (record === null) {
      console.log("no fence handoff record present");
      return;
    }
    console.log(JSON.stringify(record));
  }
}
