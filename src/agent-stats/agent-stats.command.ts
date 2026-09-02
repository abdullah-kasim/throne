import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import {
  AGENT_STATS_NO_DATA_LINE,
  computeAgentStats,
  formatAgentStatsHuman,
} from "./agent-stats.service.ts";
import { readAgentTimingsRaw } from "../agent-timings/agent-timing-log.ts";
import { parseAgentTimings } from "../agent-timings/agent-timing.types.ts";

export interface AgentStatsCommandDependencies {
  readonly readLog: () => Promise<string>;
}

const DEFAULT_DEPENDENCIES: AgentStatsCommandDependencies = {
  readLog: readAgentTimingsRaw,
};

let productionDependencies: AgentStatsCommandDependencies | undefined;

export function configureAgentStatsCommandDependencies(
  dependencies: AgentStatsCommandDependencies,
): void {
  productionDependencies = dependencies;
}

@Command({
  name: "agent-stats",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class AgentStatsCommand extends CommandRunner {
  private readonly dependencies?: AgentStatsCommandDependencies;

  constructor(dependencies?: AgentStatsCommandDependencies) {
    super();
    this.dependencies = dependencies;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    const jsonMode = passedParams.includes("--json");
    let raw: string;
    try {
      raw = await (
        this.dependencies ??
        productionDependencies ??
        DEFAULT_DEPENDENCIES
      ).readLog();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (jsonMode)
        process.stdout.write(
          `${JSON.stringify({ source: "error", error: message })}\n`,
        );
      else process.stderr.write(`agent-stats: ${message}\n`);
      process.exitCode = 1;
      return;
    }

    const result = computeAgentStats(parseAgentTimings(raw));
    if (jsonMode) {
      process.stdout.write(
        `${JSON.stringify({ source: "agent-stats", ...result })}\n`,
      );
    } else if (result.anchor === null) {
      process.stdout.write(`${AGENT_STATS_NO_DATA_LINE}\n`);
    } else {
      process.stdout.write(`${formatAgentStatsHuman(result).join("\n")}\n`);
    }
    process.exitCode = 0;
  }
}

