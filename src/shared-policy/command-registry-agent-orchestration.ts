import {
  CreateAgentCommand,
  CreateAgentLegacyCommand,
} from "../create-agent/create-agent.command.ts";
import { KeepGoingCommand } from "../keep-going/keep-going.command.ts";
import { NoIdlingCommand } from "../no-idling/no-idling.command.ts";
import { FindUntaskedAgentsCommand } from "../no-idling/find-untasked-agents.command.ts";
import { UsageRateCommand } from "../usage-rate/usage-rate.command.ts";
import { DeriveShadowNameFromAlphaCommand } from "../derive-shadow-name-from-alpha/derive-shadow-name-from-alpha.command.ts";
import { NotifyLordCommand } from "../notify-lord/notify-lord.command.ts";
import { ListHarnessesAndModelsCommand } from "../list-harnesses-and-models/list-harnesses-and-models.command.ts";
import { SwitchAgentModelCommand } from "../switch-agent-model/switch-agent-model.command-registration.ts";
import { SwitchPersonaCommand } from "../switch-persona/switch-persona.command.ts";
import { CompleteAgentCommand } from "../complete-agent/complete-agent.command.ts";
import type { CommandRegistryEntry } from "./command-registry-entry.ts";

export const AGENT_ORCHESTRATION_COMMANDS: readonly CommandRegistryEntry[] = [
  {
    name: "create-agent",
    provider: CreateAgentCommand,
    visibility: "public",
    migrated: true,
    description: "Spawn a new herdr harness and seed its identity.",
  },
  {
    name: "create-agent-legacy",
    provider: CreateAgentLegacyCommand,
    visibility: "public",
    migrated: true,
    description:
      "Spawn a new herdr harness through the legacy model-steering path.",
  },
  {
    name: "keep-going",
    provider: KeepGoingCommand,
    visibility: "public",
    migrated: true,
    description: "Nudge the live Regent or a named agent.",
  },
  {
    name: "no-idling",
    provider: NoIdlingCommand,
    visibility: "public",
    migrated: true,
    description: "Sweep fully-idle Alpha families.",
  },
  {
    name: "find-untasked-agents",
    provider: FindUntaskedAgentsCommand,
    visibility: "public",
    migrated: true,
    description:
      "Flag any live Alpha/Shadow spawned via create-agent but never tasked via send-agent, independent of whether its family is fully idle.",
  },
  {
    name: "usage-rate",
    provider: UsageRateCommand,
    visibility: "public",
    migrated: true,
    description: "Report plan-usage burn rate.",
  },
  {
    name: "derive-shadow-name-from-alpha",
    provider: DeriveShadowNameFromAlphaCommand,
    visibility: "public",
    migrated: true,
    description:
      "Derive a canonical descendant Shadow handle from a supervising Alpha and slice id.",
  },
  {
    name: "notify-lord",
    provider: NotifyLordCommand,
    visibility: "public",
    migrated: true,
    description:
      "Send one explicit message to the Lord through the configured ntfy transport.",
  },
  {
    name: "list-harnesses-and-models",
    provider: ListHarnessesAndModelsCommand,
    visibility: "public",
    migrated: true,
    description: "List active role pools, launcher policy, and model scores.",
  },
  {
    name: "switch-agent-model",
    provider: SwitchAgentModelCommand,
    visibility: "public",
    migrated: true,
    description:
      "Safely exact-resume a registered live agent under a different same-family model.",
    ownHelp: true,
  },
  {
    name: "switch-persona",
    provider: SwitchPersonaCommand,
    visibility: "public",
    migrated: false,
    description:
      "Switch, show, or list the active roleplay persona preset (also syncs ledger addressing symlinks for existing live agents; never renames them).",
  },
  {
    name: "complete-agent",
    provider: CompleteAgentCommand,
    visibility: "public",
    migrated: true,
    description: "Reap a FINISHED agent after verifying its completion signal.",
  },
] as const;
