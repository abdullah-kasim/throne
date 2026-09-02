import type { Type } from "@nestjs/common";
import { AGENT_ORCHESTRATION_COMMANDS } from "./command-registry-agent-orchestration.ts";
import { DELIVERY_LIFECYCLE_COMMANDS } from "./command-registry-delivery-lifecycle.ts";
import type { CommandRegistryEntry } from "./command-registry-entry.ts";
import { PLATFORM_COMMANDS } from "./command-registry-platform.ts";
import { QUEUE_COMMANDS } from "./command-registry-queue.ts";
import { RUNTIME_COMMANDS } from "./command-registry-runtime.ts";

export type {
  CommandRegistryEntry,
  CommandVisibility,
} from "./command-registry-entry.ts";

/**
 * The single authoritative ordered command roster. Responsibility modules own
 * cohesive command families; this public composition preserves the global
 * dispatch/help/provider order consumed throughout the application.
 */
export const COMMAND_REGISTRY: readonly CommandRegistryEntry[] = [
  ...RUNTIME_COMMANDS,
  ...AGENT_ORCHESTRATION_COMMANDS,
  ...DELIVERY_LIFECYCLE_COMMANDS,
  ...QUEUE_COMMANDS,
  ...PLATFORM_COMMANDS,
] as const;

export const COMMAND_REGISTRY_PROVIDERS: readonly Type<unknown>[] =
  COMMAND_REGISTRY.map((entry) => entry.provider);

export function publicCommandNames(): readonly string[] {
  return COMMAND_REGISTRY.filter((entry) => entry.visibility === "public").map(
    (entry) => entry.name,
  );
}

export function internalDispatchableCommandNames(): readonly string[] {
  return COMMAND_REGISTRY.filter(
    (entry) => entry.visibility === "internal",
  ).map((entry) => entry.name);
}

export function migratedCommandNames(): readonly string[] {
  return COMMAND_REGISTRY.filter((entry) => entry.migrated).map(
    (entry) => entry.name,
  );
}
