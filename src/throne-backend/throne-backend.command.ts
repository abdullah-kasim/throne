import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { THRONE_BACKEND_SERVICE_UNIT_NAME } from "../status/service-health.ts";
import { writeServiceGenerationMarkerSafely } from "../status/service-generation-marker.ts";
import { runThroneBackendForever } from "./throne-backend-app.ts";

/**
 * `throne-backend`: the long-running server hosting no-idling and the
 * throne-work dispatch loop as in-process cron/long-lived workers.
 * The systemd-managed daemon shape, never a one-shot command — mirrors
 * `throne-work`'s own invocation contract so `systemd/throne-backend.service`
 * has a stable `ExecStart` target.
 */
@Command({
  name: "throne-backend",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class ThroneBackendCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(): Promise<void> {
    // Read back by transport staleness detection (see
    // src/transport/transport-staleness-check.ts). Stamped once here at
    // startup; kept current for the life of the process by
    // `ServiceGenerationMarkerRefreshHostedWorker`, one of the workers
    // `runThroneBackendForever` boots below. A failure to write must never
    // block the server itself -- `writeServiceGenerationMarkerSafely` owns
    // that containment.
    writeServiceGenerationMarkerSafely(
      THRONE_BACKEND_SERVICE_UNIT_NAME,
      import.meta.url,
      new Date().toISOString(),
      process.pid,
    );
    await runThroneBackendForever();
  }
}
