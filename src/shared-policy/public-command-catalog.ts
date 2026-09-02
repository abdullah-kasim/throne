import { COMMAND_REGISTRY } from "./command-registry.ts";

/**
 * Derived from COMMAND_REGISTRY (see that file's header comment for why it
 * is the single source of truth). `PUBLIC_COMMANDS` and
 * `INTERNAL_DISPATCHABLE_COMMANDS` used to be two independently
 * hand-maintained lists that could (and did) drift from the registered
 * provider set and from each other; both are now a pure projection of the
 * registry and cannot disagree with it by construction.
 */
export const PUBLIC_COMMANDS: Readonly<Record<string, string>> =
  Object.fromEntries(
    COMMAND_REGISTRY.filter((entry) => entry.visibility === "public").map(
      (entry) => [entry.name, entry.description ?? ""],
    ),
  );

export type PublicCommandName = keyof typeof PUBLIC_COMMANDS;

/**
 * Commands that are real, Nest-dispatchable providers but must never appear
 * in `--help` or the public catalog above — deliberately undocumented,
 * tab-resident/internal entry points. Derived from `COMMAND_REGISTRY` so the
 * admission gate can dispatch these without exposing them publicly, and so a
 * command can never silently fall out of both lists at once.
 */
export const INTERNAL_DISPATCHABLE_COMMANDS: readonly string[] =
  COMMAND_REGISTRY.filter((entry) => entry.visibility === "internal").map(
    (entry) => entry.name,
  );

export type InternalDispatchableCommandName =
  (typeof INTERNAL_DISPATCHABLE_COMMANDS)[number];

/**
 * `--help`/`-h` DESCRIBES a command and never runs it. Every individual
 * `@Command` class disables Commander's own `--help` handling
 * (`command.helpOption(false)`, paired with `allowUnknownOptions`/
 * `allowExcessArgs`) so its argument parsing stays permissive — but that
 * means `--help` was never consumed as help at all: it fell through as an
 * ordinary unknown argument and the command's `run()` executed for real.
 * Rather than re-enable `helpOption` in ~45 individual command files (each
 * would need re-verifying against its own permissive-parsing needs), this
 * single registry-derived check runs in `executeCommand` BEFORE any command
 * is dispatched, for every admitted command uniformly, public or internal.
 */
export function commandHasOwnHelp(name: string): boolean {
  return COMMAND_REGISTRY.some(
    (candidate) => candidate.name === name && candidate.ownHelp === true,
  );
}

export function renderCommandHelp(name: string): string {
  const entry = COMMAND_REGISTRY.find((candidate) => candidate.name === name);
  const description = entry?.description?.trim();
  return [
    `${name} — ${description && description.length > 0 ? description : "No public description (internal command)."}`,
    `Usage: ./bin/throne-cli ${name} [args...]`,
    "",
  ].join("\n");
}

export function renderPublicCommandUsage(featureFlags: string): string {
  const width = Math.max(...Object.keys(PUBLIC_COMMANDS).map((name) => name.length));
  return [
    "Usage: ./bin/throne-cli <command> [args...]",
    "",
    `Feature flags: ${featureFlags}`,
    '  Strict JSON object: {"herdr-decouple": true|false}; absent defaults OFF.',
    '  Optional "send-agent-file-backed-payloads": true|false; absent defaults OFF.',
    '  OFF: do not acquire, install, or control the pinned client.',
    '  ON: verify/install the pinned client, public throne seam, and decoupled service.',
    '  Changing the flag never touches or restarts a live server; service handoff is separate.',
    "",
    "Commands:",
    ...Object.entries(PUBLIC_COMMANDS).map(([name, description]) =>
      `  ${name.padEnd(width)}  ${description}`),
    "",
  ].join("\n");
}
