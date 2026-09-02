export type TransportMode = "local" | "rest";

export interface TransportModeFlags {
  readonly transport?: string;
  readonly local?: boolean;
}

/**
 * Registered command identifiers that must always run in-process, regardless
 * of requested flags: they are the only tools left to diagnose and repair a
 * wedged `throne-backend`, so none of them may depend on it being alive.
 *
 * - `status` — the service-diagnostics command; its report pulls
 *   `readServiceHealth`/`readServiceGenerationStaleness` in-process.
 * - `install-services`
 * - `agent-statuses`
 * - `send-agent-legacy` — writes to herdr panes directly instead of through
 *   the queue the backend owns, so it is the one command that can still task
 *   a repair while the backend itself is the thing that's broken.
 */
export const RESCUE_SET_COMMAND_NAMES: readonly string[] = [
  "status",
  "install-services",
  "agent-statuses",
  "send-agent-legacy",
];

function isRescueSetCommand(commandName: string): boolean {
  return RESCUE_SET_COMMAND_NAMES.includes(commandName);
}

/**
 * The single place transport eligibility is decided. `--local` always wins;
 * a rescue-set command name always resolves `local` regardless of flags,
 * because those commands must survive the backend they'd otherwise call
 * being dead.
 */
export function resolveTransportMode(flags: TransportModeFlags, commandName: string): TransportMode {
  if (flags.local) return "local";
  if (isRescueSetCommand(commandName)) return "local";
  return flags.transport === "rest" ? "rest" : "local";
}
