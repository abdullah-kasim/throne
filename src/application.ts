import type { INestApplicationContext } from "@nestjs/common";
import type { Command as CommanderCommand } from "commander";
import { CommandFactory, CommandRunnerService } from "nest-commander";
import { NestCommanderApplicationModule } from "./application.module.ts";
import {
  configureAgentStatsCommandDependencies,
  type AgentStatsCommandDependencies,
} from "./agent-stats/agent-stats.command.ts";
import { configureSendAgentCommandDependencies } from "./send-agent/send-agent.command.ts";
import type { SendAgentCommandDependencies } from "./send-agent/send-agent-dependencies.types.ts";
import {
  configureKeepGoingDependencies,
  type KeepGoingDependencies,
} from "./keep-going/keep-going.command.ts";
import {
  configureNoIdlingDependencies,
  type NoIdlingDependencies,
} from "./no-idling/no-idling.command.ts";
import {
  configureUsageRateDependencies,
  type UsageRateDependencies,
} from "./usage-rate/usage-rate.command.ts";
import { configureAgentLogsReader } from "./agent-logs/agent-logs.command.ts";
import type { AgentLogsReader } from "./agent-logs/agent-logs.ts";
import { readAgent } from "./herdr/herdr-runtime.service.ts";
import { writeSwitchAgentModelFrameworkFailure } from "./switch-agent-model/command-arguments.ts";
import { configureCompleteAgentDependencies } from "./complete-agent/complete-agent.command.ts";
import type { CompleteAgentDependencies } from "./complete-agent/complete-agent.ts";
import { configureReapAgentDependencies } from "./reap-agent/reap-agent.command.ts";
import type { ReapDeps } from "./reap-agent/reap-agent.types.ts";
import { configureOpenCodeGoUsageDependencies } from "./opencode-go-usage-remaining/opencode-go-usage-remaining.command.ts";
import type { OpenCodeGoUsageDeps } from "./opencode-go-usage-remaining/opencode-go-usage.service.ts";
import {
  commandHasOwnHelp,
  INTERNAL_DISPATCHABLE_COMMANDS,
  PUBLIC_COMMANDS,
  renderCommandHelp,
  renderPublicCommandUsage,
} from "./shared-policy/public-command-catalog.ts";
import { featureFlagsPath } from "./shared-policy/feature-flags.service.ts";
import { bootstrapRuntimeDataHome } from "./shared-policy/runtime-data-migration.ts";
import {
  renderEntranceRefusal,
  renderFrameworkEntranceRefusal,
  type EntranceRefusalBypass,
} from "./shared-policy/entrance-refusal.ts";

export const COMMANDS = PUBLIC_COMMANDS;

type NestCommanderOptions =
  | false
  | {
      readonly logger: false;
      readonly errorHandler?: (error: Error) => never;
      readonly outputConfiguration?: {
        readonly writeErr: (text: string) => void;
      };
      readonly serviceErrorHandler: (error: Error) => void;
    };

export interface CommandExecutionDependencies {
  runNestCommand(argv: readonly string[]): Promise<number>;
  bootstrapRuntimeDataHome?(): Promise<unknown>;
  admitInspection?(argv: readonly string[]): Promise<{
    readonly admitted: boolean;
    readonly argv: readonly string[];
    readonly diagnostic?: string;
    readonly bypass: EntranceRefusalBypass;
  }>;
  writeDiagnostic(text: string): void;
}

const AGENT_STATUSES_COMMAND_NAME = "agent-statuses";
const SEND_AGENT_COMMAND_NAME = "send-agent";
const KEEP_GOING_COMMAND_NAME = "keep-going";
const NO_IDLING_COMMAND_NAME = "no-idling";
const AGENT_LOGS_COMMAND_NAME = "agent-logs";
const SWITCH_AGENT_MODEL_COMMAND_NAME = "switch-agent-model";
const FRAMEWORK_STEERED_COMMANDS = new Set([
  "consume-fence-handoff-on-start",
  "migrate-queue-markdown",
]);

function throwFrameworkEntranceError(error: Error): never {
  throw error;
}

function configureFrameworkSteeredChildParser(
  runner: CommandRunnerService,
  commandName: string | undefined,
): void {
  if (!FRAMEWORK_STEERED_COMMANDS.has(commandName ?? "")) return;
  const commander = (runner as unknown as {
    readonly commander: CommanderCommand;
  }).commander;
  commander.commands
    .find((command) => command.name() === commandName)
    ?.exitOverride(throwFrameworkEntranceError);
}

function isAgentStatusesCommand(argv: readonly string[]): boolean {
  return argv[2] === AGENT_STATUSES_COMMAND_NAME;
}

function writeAgentStatusesServiceError(error: Error): void {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

function isSendAgentCommand(argv: readonly string[]): boolean {
  return argv[2] === SEND_AGENT_COMMAND_NAME;
}

function writeFrameworkEntranceRefusal(
  commandName: string,
  error: Error,
): void {
  process.stderr.write(
    `${renderFrameworkEntranceRefusal(commandName, error.message, { available: false })}\n`,
  );
  process.exitCode = 1;
}

const HELP_FLAGS = new Set(["--help", "-h"]);

// argv[0]=node, argv[1]=script, argv[2]=command name -- only flags AFTER the
// command name request that command's help; `throne-cli --help` (no command
// name) is unaffected and keeps falling through to the "Unknown command"
// catalog listing exactly as before.
function requestsCommandHelp(argv: readonly string[]): boolean {
  return argv.slice(3).some((arg) => HELP_FLAGS.has(arg));
}

export function nestCommanderApplicationOptions(
  argv: readonly string[],
  serviceErrorHandler?: (error: Error) => void,
): NestCommanderOptions {
  if (FRAMEWORK_STEERED_COMMANDS.has(argv[2] ?? "")) {
    return {
      logger: false as const,
      errorHandler: throwFrameworkEntranceError,
      outputConfiguration: { writeErr: () => undefined },
      serviceErrorHandler:
        serviceErrorHandler ??
        ((error: Error) => writeFrameworkEntranceRefusal(argv[2]!, error)),
    };
  }
  if (argv[2] === SWITCH_AGENT_MODEL_COMMAND_NAME) {
    return {
      logger: false as const,
      serviceErrorHandler:
        serviceErrorHandler ?? writeSwitchAgentModelFrameworkFailure,
    };
  }
  if (isAgentStatusesCommand(argv) || argv[2] === AGENT_LOGS_COMMAND_NAME)
    return {
      logger: false as const,
      serviceErrorHandler:
        serviceErrorHandler ?? writeAgentStatusesServiceError,
    };
  if (isSendAgentCommand(argv)) {
    return {
      logger: false as const,
      serviceErrorHandler:
        serviceErrorHandler ??
        ((error: Error) =>
          writeFrameworkEntranceRefusal(SEND_AGENT_COMMAND_NAME, error)),
    };
  }
  if (
    argv[2] === KEEP_GOING_COMMAND_NAME ||
    argv[2] === NO_IDLING_COMMAND_NAME
  ) {
    return {
      logger: false as const,
      serviceErrorHandler:
        serviceErrorHandler ??
        ((error: Error) => writeFrameworkEntranceRefusal(argv[2]!, error)),
    };
  }
  return {
    logger: false as const,
    serviceErrorHandler:
      serviceErrorHandler ??
      ((error: Error) =>
        writeFrameworkEntranceRefusal(argv[2] ?? "command", error)),
  };
}

export async function createNestCommanderApplication(): Promise<INestApplicationContext> {
  return CommandFactory.createWithoutRunning(
    NestCommanderApplicationModule,
    false,
  );
}

export async function closeNestCommanderApplication(
  application: INestApplicationContext,
): Promise<void> {
  await application.close();
}

export async function runNestCommanderApplication(
  argv: readonly string[],
  sendAgentDependencies?: SendAgentCommandDependencies,
  keepGoingDependencies?: KeepGoingDependencies,
  agentLogsReader?: AgentLogsReader,
  usageRateDependencies?: UsageRateDependencies,
  agentStatsDependencies?: AgentStatsCommandDependencies,
  noIdlingDependencies?: NoIdlingDependencies,
  completeAgentDependencies?: CompleteAgentDependencies,
  reapAgentDependencies?: ReapDeps,
  openCodeGoUsageDependencies?: OpenCodeGoUsageDeps,
  serviceErrorHandler?: (error: Error) => void,
): Promise<number> {
  if (agentStatsDependencies !== undefined) {
    configureAgentStatsCommandDependencies(agentStatsDependencies);
  }
  if (sendAgentDependencies !== undefined) {
    configureSendAgentCommandDependencies(sendAgentDependencies);
  }
  if (keepGoingDependencies !== undefined) {
    configureKeepGoingDependencies(keepGoingDependencies);
  }
  if (noIdlingDependencies !== undefined) {
    configureNoIdlingDependencies(noIdlingDependencies);
  }
  if (agentLogsReader !== undefined) configureAgentLogsReader(agentLogsReader);
  if (usageRateDependencies !== undefined) {
    configureUsageRateDependencies(usageRateDependencies);
  }
  if (completeAgentDependencies !== undefined) {
    configureCompleteAgentDependencies(completeAgentDependencies);
  }
  if (reapAgentDependencies !== undefined) {
    configureReapAgentDependencies(reapAgentDependencies);
  }
  if (openCodeGoUsageDependencies !== undefined) {
    configureOpenCodeGoUsageDependencies(openCodeGoUsageDependencies);
  }
  const application = await CommandFactory.createWithoutRunning(
    NestCommanderApplicationModule,
    nestCommanderApplicationOptions(argv, serviceErrorHandler),
  );
  try {
    const runner = application.get(CommandRunnerService);
    configureFrameworkSteeredChildParser(runner, argv[2]);
    await runner.run([...argv]);
    return Number(process.exitCode ?? 0);
  } finally {
    await closeNestCommanderApplication(application);
  }
}

export async function runNestCommanderProduction(): Promise<number> {
  configureAgentLogsReader(readAgent);
  return runNestCommanderApplication(process.argv);
}

export function renderCliUsage(): string {
  return renderPublicCommandUsage(featureFlagsPath());
}

export async function executeCommand(
  argv: readonly string[],
  dependencies: CommandExecutionDependencies = {
    runNestCommand: () => runNestCommanderProduction(),
    bootstrapRuntimeDataHome,
    writeDiagnostic: (text) => process.stderr.write(text),
  },
): Promise<number> {
  await dependencies.bootstrapRuntimeDataHome?.();
  const commandName = argv[2];
  const isDispatchable =
    commandName !== undefined &&
    (commandName in COMMANDS ||
      (INTERNAL_DISPATCHABLE_COMMANDS as readonly string[]).includes(
        commandName,
      ));
  if (!isDispatchable) {
    if (commandName !== undefined) {
      dependencies.writeDiagnostic(
        `${renderEntranceRefusal({
          reason: `Unknown command: ${commandName}. The command is not in the registered dispatch catalog.`,
          bypass: undefined,
          supervisorRoute:
            "Ask your supervisor which registered command provides the needed operation.",
        })}\n\n`,
      );
    }
    dependencies.writeDiagnostic(renderCliUsage());
    return 1;
  }

  if (requestsCommandHelp(argv) && !commandHasOwnHelp(commandName)) {
    dependencies.writeDiagnostic(renderCommandHelp(commandName));
    return 0;
  }

  const admission = await (dependencies.admitInspection?.(argv) ??
    Promise.resolve({
      admitted: true,
      argv,
      bypass: { available: false } as const,
    }));
  if (!admission.admitted) {
    dependencies.writeDiagnostic(
      `${renderEntranceRefusal({
        reason:
          admission.diagnostic ??
          "The command was refused by an entrance policy gate.",
        bypass: admission.bypass.available
          ? admission.bypass.guidance
          : undefined,
        supervisorRoute:
          "Ask your supervisor for an allowed alternative invocation.",
      })}\n`,
    );
    return 1;
  }
  return dependencies.runNestCommand(admission.argv);
}
