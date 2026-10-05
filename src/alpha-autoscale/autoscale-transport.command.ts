import { Command as CommanderCommand } from "commander";
import { CommandRunner } from "nest-commander";
import type { TransportClient } from "../transport/transport-client.ts";
import { createAlphaAutoscaleTransportClient } from "./alpha-autoscale-route.ts";

export abstract class AutoscaleTransportCommand extends CommandRunner {
  protected readonly transportClient: TransportClient;

  constructor(transportClient?: TransportClient) {
    super();
    this.transportClient = transportClient ?? createAlphaAutoscaleTransportClient();
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }
}
