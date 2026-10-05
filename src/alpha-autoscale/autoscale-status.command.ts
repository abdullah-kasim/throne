import { Command } from "nest-commander";
import type { TransportClient } from "../transport/transport-client.ts";
import type { CapturedSinks } from "../transport/manual-trigger-route.ts";
import { resolveTransportMode } from "../transport/resolve-transport-mode.ts";
import { parseAlphaAutoscaleArgs } from "./alpha-autoscale-route.ts";
import { AutoscaleTransportCommand } from "./autoscale-transport.command.ts";
import {
  renderAutoscaleStatusFrom,
  requestAutoscaleStatusFromBackend,
} from "./autoscale-status-route.ts";
import {
  resolveAutoscaleStatusSources,
  type AutoscaleStatusSources,
} from "./autoscale-status-report.ts";

const COMMAND_NAME = "autoscale-status";

const PROCESS_OUTPUT: CapturedSinks = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function showAutoscaleStatus(
  args: readonly string[],
  transportClient: TransportClient,
  localSources: AutoscaleStatusSources,
  output: CapturedSinks,
): Promise<number> {
  const { transport, local, remainingArgs } = parseAlphaAutoscaleArgs(args);
  if (resolveTransportMode({ transport, local }, COMMAND_NAME) === "rest") {
    const reply = await requestAutoscaleStatusFromBackend(transportClient, remainingArgs);
    if (reply.reached) {
      output.stdout(reply.result.stdout);
      output.stderr(reply.result.stderr);
      return reply.result.exitCode;
    }
    output.stderr(`${COMMAND_NAME}: ${reply.reason}; reading the status in this shell instead\n`);
  }
  output.stdout(await renderAutoscaleStatusFrom(localSources, remainingArgs));
  return 0;
}

@Command({
  name: "autoscale-status",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class AutoscaleStatusCommand extends AutoscaleTransportCommand {
  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await showAutoscaleStatus(
      passedParams ?? [],
      this.transportClient,
      resolveAutoscaleStatusSources(),
      PROCESS_OUTPUT,
    );
  }
}
