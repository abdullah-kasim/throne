import { Command as CommanderCommand } from "commander";
import { Optional } from "@nestjs/common";
import { Command, CommandRunner } from "nest-commander";
import { AlphaAutoscaleHostedWorker } from "./alpha-autoscale.hosted-worker.ts";
import { TransportClient } from "../transport/transport-client.ts";
import { resolveTransportMode } from "../transport/resolve-transport-mode.ts";
import {
  parseAlphaAutoscaleArgs,
  runAlphaAutoscaleOverTransport,
} from "./alpha-autoscale-route.ts";

/**
 * Published one-shot entry to the alpha-autoscale sweep. Defaults
 * (unflagged, and `--local`) to the original behavior unchanged: calling
 * `worker.runOnce()` directly in this CLI process. `--transport rest`
 * instead reaches the same sweep inside the live `throne-backend` process
 * over the unix-socket transport, through `alpha-autoscale-route.ts`'s
 * client helper -- the route this command's manual pokes now share
 * `alphaAutoscaleExecutionGate` with the hosted cron tick, so they can never
 * run concurrently with it. The local path stays as the default because it
 * is today's exact existing behavior and the fallback named on a
 * `--transport rest` failure; `--transport rest` is opt-in, matching the
 * `keep-going`/`no-idling` pattern rather than flipping this command's
 * default onto the backend.
 */
@Command({
  name: "alpha-autoscale-tick",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class AlphaAutoscaleTickCommand extends CommandRunner {
  private readonly transportClient: TransportClient;

  constructor(
    private readonly worker: AlphaAutoscaleHostedWorker,
    @Optional() transportClient?: TransportClient,
  ) {
    super();
    this.transportClient = transportClient ?? new TransportClient();
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    const { transport, local, remainingArgs } = parseAlphaAutoscaleArgs(passedParams ?? []);
    const mode = resolveTransportMode({ transport, local }, "alpha-autoscale-tick");
    if (mode === "rest") {
      process.exitCode = await runAlphaAutoscaleOverTransport(this.transportClient, remainingArgs);
      return;
    }
    await this.worker.runOnce();
  }
}
