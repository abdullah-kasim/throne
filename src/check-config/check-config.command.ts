import { Injectable } from "@nestjs/common";
import { Command, CommandRunner } from "nest-commander";
import { run } from "./check-config.ts";

@Command({
  name: "check-config",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
@Injectable()
export class CheckConfigCommand extends CommandRunner {
  async run(): Promise<void> {
    try {
      process.exitCode = await run();
    } catch (error) {
      process.stderr.write(
        `check-config: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
