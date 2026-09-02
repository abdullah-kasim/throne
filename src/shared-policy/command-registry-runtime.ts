import { AssertHerdrCommand } from "../assert-herdr/assert-herdr.command.ts";
import { AgentLogsCommand } from "../agent-logs/agent-logs.command.ts";
import { AgentStatusesCommand } from "../agent-statuses/agent-statuses.command.ts";
import { AgentStatsCommand } from "../agent-stats/agent-stats.command.ts";
import { ReadPayloadCommand } from "../read-payload/read-payload.command.ts";
import { SendAgentCommand } from "../send-agent/send-agent.command.ts";
import { SendAgentLegacyCommand } from "../send-agent-legacy/send-agent-legacy.command.ts";
import { MessageStatusCommand } from "../message-status/message-status.command.ts";
import { CancelMessageCommand } from "../cancel-message/cancel-message.command.ts";
import { DeliveryFailuresCommand } from "../delivery-failures/delivery-failures.command.ts";
import { ThroneBackendCommand } from "../throne-backend/throne-backend.command.ts";
import { QueueHealthCommand } from "../throne-work/queue-health.command.ts";
import { VerifyDeliveryPathCommand } from "../message-queue/verify-delivery-path.command.ts";
import { VerifyAlphaFloorDeliveryCommand } from "../alpha-autoscale/verify-alpha-floor-delivery.command.ts";
import { AlphaAutoscaleTickCommand } from "../alpha-autoscale/alpha-autoscale-tick.command.ts";
import type { CommandRegistryEntry } from "./command-registry-entry.ts";

export const RUNTIME_COMMANDS: readonly CommandRegistryEntry[] = [
  {
    name: "assert-herdr",
    provider: AssertHerdrCommand,
    visibility: "public",
    migrated: true,
    description: "Refuse to run unless inside a herdr session.",
  },
  {
    name: "agent-logs",
    provider: AgentLogsCommand,
    visibility: "public",
    migrated: true,
    description: "Print a named agent's recent output.",
  },
  {
    name: "agent-statuses",
    provider: AgentStatusesCommand,
    visibility: "public",
    migrated: true,
    description: "Print a table of every herdr agent and its status.",
  },
  {
    name: "agent-stats",
    provider: AgentStatsCommand,
    visibility: "public",
    migrated: true,
    description: "Report trailing-7-day agent timing statistics.",
  },
  {
    name: "read-payload",
    provider: ReadPayloadCommand,
    visibility: "public",
    migrated: true,
    description:
      "Read one throne-owned staged payload completely, then delete it.",
  },
  {
    name: "send-agent",
    provider: SendAgentCommand,
    visibility: "public",
    migrated: true,
    description:
      "Send one resident-draft-safe message to a named agent (then Enter unless suppressed).",
  },
  {
    name: "send-agent-legacy",
    provider: SendAgentLegacyCommand,
    visibility: "public",
    migrated: false,
    description:
      "Fallback: deliver synchronously via the pre-queue path, independent of send-agent/throne-work.",
  },
  {
    name: "message-status",
    provider: MessageStatusCommand,
    visibility: "public",
    migrated: false,
    description:
      "Poll a durable message queue row for its typed delivery state.",
  },
  {
    name: "cancel-message",
    provider: CancelMessageCommand,
    visibility: "public",
    migrated: false,
    description:
      "Cancel one scheduled message before delivery begins.",
  },
  {
    name: "delivery-failures",
    provider: DeliveryFailuresCommand,
    visibility: "public",
    migrated: false,
    description:
      "List (or acknowledge) a sender's unacknowledged closed-loop delivery-failure notices.",
  },
  {
    name: "throne-backend",
    provider: ThroneBackendCommand,
    visibility: "public",
    migrated: false,
    description:
      "Run the long-lived NestJS server hosting keep-going, no-idling, and the throne-work dispatch loop as in-process cron/long-lived workers.",
  },
  {
    name: "queue-health",
    provider: QueueHealthCommand,
    visibility: "public",
    migrated: false,
    description:
      "Prove the message queue is reachable end to end with one typed verdict.",
  },
  {
    name: "verify-delivery-path",
    provider: VerifyDeliveryPathCommand,
    visibility: "public",
    migrated: false,
    description: "Prove the SQLite delivery path end to end with one typed verdict.",
  },
  {
    name: "verify-alpha-floor-delivery",
    provider: VerifyAlphaFloorDeliveryCommand,
    visibility: "public",
    migrated: false,
    description:
      "Prove the alpha-floor breach notifier's cron-owned sender identity delivers end to end.",
  },
  {
    name: "alpha-autoscale-tick",
    provider: AlphaAutoscaleTickCommand,
    visibility: "public",
    migrated: false,
    description: "Run one published alpha-autoscale watchdog tick.",
  },
] as const;
