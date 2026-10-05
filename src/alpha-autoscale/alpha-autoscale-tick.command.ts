import { Optional } from "@nestjs/common";
import { Command } from "nest-commander";
import { AlphaAutoscaleHostedWorker } from "./alpha-autoscale.hosted-worker.ts";
import { TransportClient } from "../transport/transport-client.ts";
import { resolveTransportMode } from "../transport/resolve-transport-mode.ts";
import { parseAlphaAutoscaleArgs, runAlphaAutoscaleOverTransport } from "./alpha-autoscale-route.ts";
import { AutoscaleTransportCommand } from "./autoscale-transport.command.ts";

@Command({
  name: "alpha-autoscale-tick",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class AlphaAutoscaleTickCommand extends AutoscaleTransportCommand {
  constructor(
    private readonly worker: AlphaAutoscaleHostedWorker,
    @Optional() transportClient?: TransportClient,
  ) {
    super(transportClient);
  }

  async run(passedParams: string[]): Promise<void> {
    const { transport, local, remainingArgs } = parseAlphaAutoscaleArgs(passedParams ?? []);
    const mode = resolveTransportMode({ transport, local }, "alpha-autoscale-tick");
    if (mode === "rest") {
      process.exitCode = await runAlphaAutoscaleOverTransport(this.transportClient, remainingArgs);
      return;
    }
    process.stderr.write("alpha-autoscale-tick: transport local: running the sweep in this process\n");
    await this.worker.runOnce();
  }
}

/**
 * `autoscale-now` -- the same sweep under the name a human reaches for. The
 * Lord, 2026-09-02: "we need a cli command to trigger the autoscaler to run
 * a check now so that we don't have to wait 10 mins". `alpha-autoscale-tick`
 * already was that command; nobody could find it by that name. This is a
 * pure alias: same class body, same transport flags, same gates, same
 * serialisation through `alphaAutoscaleExecutionGate` -- a manual check can
 * never race the cron tick.
 */
@Command({
  name: "autoscale-now",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class AutoscaleNowCommand extends AlphaAutoscaleTickCommand {}
