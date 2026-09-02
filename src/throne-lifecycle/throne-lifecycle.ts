import {
  SYSTEMD_UNIT_NAMES,
  type ServiceCommandResult,
} from "../install-services/service-unit-renderer.service.ts";

/**
 * Units `disable-throne` acts on. `throne-backend.service` is deliberately
 * absent: it hosts the keep-going cron that resurrects a dead Regent, so
 * disable-throne must never stop or disable it.
 */
export const THRONE_LIFECYCLE_DISABLE_UNITS = [
  SYSTEMD_UNIT_NAMES.NTFY,
] as const;

/**
 * Units `enable-throne` acts on. Includes `throne-backend.service` so
 * enabling the throne genuinely restores its watchdog, not just its
 * administrative units.
 */
export const THRONE_LIFECYCLE_ENABLE_UNITS = [
  SYSTEMD_UNIT_NAMES.NTFY,
  SYSTEMD_UNIT_NAMES.THRONE_BACKEND,
] as const;

/**
 * `enable-throne`/`disable-throne` operate the systemd units and NOTHING else.
 * They deliberately message no one (Lord, 2026-08-21).
 *
 * They used to broadcast a pause/resume line to every live Alpha and Shadow on
 * the roster. That was redundant with the units themselves — enabling or
 * disabling the timers already changes what the court does — and it made a
 * court-wide interrupt reachable by any agent that could run the command. It
 * fired for real: `shadow-ent-99e`, the delivery gate of the throne-units
 * campaign, smoke-checked its own feature against the live court and nudged
 * eleven agents at once, which then perturbed the idleness signals the Regent
 * steers by. Do not reintroduce a recipient list here.
 */
export interface ThroneLifecycleDeps {
  readonly systemctl: (args: string[]) => Promise<ServiceCommandResult>;
}

export interface ThroneLifecycleTargetResult {
  readonly target: string;
  readonly action: "unit";
  readonly ok: boolean;
  readonly detail: string;
}

export interface ThroneLifecycleResult {
  readonly code: number;
  readonly results: readonly ThroneLifecycleTargetResult[];
}

function formatServiceResult(result: ServiceCommandResult): string {
  return result.code === 0
    ? "completed"
    : result.stderr.trim() || `exited ${result.code}`;
}

async function runIndependentEffects(
  effects: readonly (() => Promise<ThroneLifecycleTargetResult>)[],
): Promise<readonly ThroneLifecycleTargetResult[]> {
  const results: ThroneLifecycleTargetResult[] = [];
  for (const effect of effects) {
    try {
      results.push(await effect());
    } catch (error) {
      results.push({
        target: "unknown",
        action: "unit",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function unitEffects(
  verb: "disable" | "enable",
  deps: ThroneLifecycleDeps,
): readonly (() => Promise<ThroneLifecycleTargetResult>)[] {
  const units =
    verb === "enable"
      ? THRONE_LIFECYCLE_ENABLE_UNITS
      : THRONE_LIFECYCLE_DISABLE_UNITS;
  return units.map((unit) => async () => {
    const result = await deps.systemctl([
      "--user",
      verb,
      "--now",
      ...(verb === "enable" ? ["--no-block"] : []),
      unit,
    ]);
    return {
      target: unit,
      action: "unit",
      ok: result.code === 0,
      detail: formatServiceResult(result),
    };
  });
}

export async function disableThrone(
  deps: ThroneLifecycleDeps,
): Promise<ThroneLifecycleResult> {
  const results = await runIndependentEffects(unitEffects("disable", deps));
  return { code: results.every((result) => result.ok) ? 0 : 1, results };
}

export async function enableThrone(
  deps: ThroneLifecycleDeps,
): Promise<ThroneLifecycleResult> {
  const results = await runIndependentEffects(unitEffects("enable", deps));
  return { code: results.every((result) => result.ok) ? 0 : 1, results };
}
