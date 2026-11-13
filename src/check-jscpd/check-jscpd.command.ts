import { Injectable } from "@nestjs/common";
import { Command, CommandRunner } from "nest-commander";
import { run } from "./check-jscpd.ts";

@Command({
  name: "check-jscpd",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
@Injectable()
export class CheckJscpdCommand extends CommandRunner {
  async run(): Promise<void> {
    try {
      process.exitCode = await run();
    } catch (error) {
      process.stderr.write(
        `check-jscpd: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
