import { Optional } from "@nestjs/common";
import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner, Option } from "nest-commander";
import { runManualTriggerOverTransport } from "../transport/manual-trigger-route.ts";
import { resolveTransportMode } from "../transport/resolve-transport-mode.ts";
import type { TransportClient } from "../transport/transport-client.ts";
import {
  AGENT_SETTINGS_ROUTE_PATH,
  AGENT_SETTINGS_TICK_COMMAND_NAME,
  createAgentSettingsTransportClient,
  routeArgumentsOf,
  writeAgentSettingsTickLines,
} from "./agent-settings-route.ts";

const TRANSPORT_WHEN_NONE_IS_NAMED = "rest";

interface AgentSettingsTickOptions {
  readonly dryRun?: boolean;
  readonly local?: boolean;
  readonly transport?: string;
}

@Command({
  name: "agent-settings-tick",
  description:
    "Check every agent's colour and session name once, now, and correct what differs.",
})
export class AgentSettingsTickCommand extends CommandRunner {
  private readonly transportClient: TransportClient;

  constructor(@Optional() transportClient?: TransportClient) {
    super();
    this.transportClient =
      transportClient ?? createAgentSettingsTransportClient();
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  @Option({
    flags: "--dry-run",
    description: "Print what would change and change nothing.",
  })
  parseDryRun(): boolean {
    return true;
  }

  @Option({
    flags: "--local",
    description: "Run the check in this process instead of the backend.",
  })
  parseLocal(): boolean {
    return true;
  }

  @Option({
    flags: "--transport <transport>",
    description: "Where the check runs: rest (the backend) or local.",
  })
  parseTransport(value: string): string {
    return value;
  }

  async run(
    _passedParams: string[],
    options: AgentSettingsTickOptions = {},
  ): Promise<void> {
    const request = { dryRun: options.dryRun === true };
    const transportMode = resolveTransportMode(
      {
        transport: options.transport ?? TRANSPORT_WHEN_NONE_IS_NAMED,
        local: options.local,
      },
      AGENT_SETTINGS_TICK_COMMAND_NAME,
    );
    if (transportMode === "rest") {
      process.exitCode = await runManualTriggerOverTransport(
        this.transportClient,
        {
          commandName: AGENT_SETTINGS_TICK_COMMAND_NAME,
          routePath: AGENT_SETTINGS_ROUTE_PATH,
          args: routeArgumentsOf(request),
        },
      );
      return;
    }
    await writeAgentSettingsTickLines(request, (text) =>
      process.stdout.write(text),
    );
  }
}
