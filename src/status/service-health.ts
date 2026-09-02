import {
  isSystemdUnavailable,
  REAL_SERVICE_UNIT_DEPS,
  SYSTEMD_UNIT_NAMES,
  type ServiceCommandResult,
} from "../install-services/service-unit-renderer.service.ts";

/** One systemd unit's read-only observed state — never mutated by this report. */
export interface ServiceHealthEntry {
  readonly unitName: string;
  readonly active: boolean;
  readonly enabled: boolean;
  /** True when systemd itself could not be reached (no user bus, binary absent). */
  readonly unavailable: boolean;
}

/**
 * `throne-backend.service` and `throne-herdr.service` are rendered by a
 * later slice (07) and may not be installed on this box yet — that is a
 * reportable state (`unavailable`/inactive), not a reason for this report to
 * omit them. Named literally here rather than through `SYSTEMD_UNIT_NAMES`
 * because that registry does not carry them yet; when 07 lands, these two
 * strings are the ones to fold into that shared registry.
 */
export const THRONE_BACKEND_SERVICE_UNIT_NAME = "throne-backend.service";
export const THRONE_HERDR_SERVICE_UNIT_NAME = "throne-herdr.service";

/**
 * The systemd units this campaign's status report cares about: the units
 * named in the assignment (herdr-server/throne-herdr, throne-backend) plus
 * the legacy keep-going/no-idling/throne-work units while they are still
 * live, per the bundle's migration-law obligation that every legacy path
 * stays observable until named retirement criteria are met.
 *
 * `throne-build.service` (BCL campaign) is deliberately NOT in this list.
 * Its unit file is never rendered or installed again — `is-active`/
 * `is-enabled` on a permanently-absent unit reports plain "inactive" /
 * "disabled", identical to a legitimate unit that is merely stopped, so
 * tracking it here would read as a health row that is always red for a
 * benign reason (Ist campaign, 2026-08-14). That teaches readers to skim
 * the whole section, which now also carries the delivery-failure alert.
 */
export const STATUS_SERVICE_UNIT_NAMES: readonly string[] = [
  SYSTEMD_UNIT_NAMES.HERDR_SERVER,
  THRONE_HERDR_SERVICE_UNIT_NAME,
  THRONE_BACKEND_SERVICE_UNIT_NAME,
  SYSTEMD_UNIT_NAMES.KEEP_GOING_SERVICE,
  SYSTEMD_UNIT_NAMES.KEEP_GOING_TIMER,
  SYSTEMD_UNIT_NAMES.NO_IDLING_SERVICE,
  SYSTEMD_UNIT_NAMES.NO_IDLING_TIMER,
  SYSTEMD_UNIT_NAMES.THRONE_WORK,
];

export interface ServiceHealthDependencies {
  readonly systemctl: (args: string[]) => Promise<ServiceCommandResult>;
}

const DEFAULT_SERVICE_HEALTH_DEPENDENCIES: ServiceHealthDependencies = {
  systemctl: REAL_SERVICE_UNIT_DEPS.systemctl,
};

async function readOneUnitHealth(
  unitName: string,
  dependencies: ServiceHealthDependencies,
): Promise<ServiceHealthEntry> {
  const active = await dependencies.systemctl(["--user", "is-active", "--quiet", unitName]);
  if (isSystemdUnavailable(active)) {
    return { unitName, active: false, enabled: false, unavailable: true };
  }
  const enabled = await dependencies.systemctl(["--user", "is-enabled", unitName]);
  return {
    unitName,
    active: active.code === 0,
    enabled: enabled.code === 0,
    unavailable: false,
  };
}

/**
 * Reads every status-relevant unit's active/enabled state. This is a pure
 * read: it never enables, disables, restarts, or otherwise mutates a unit —
 * matching this slice's hard operational constraint.
 */
export async function readServiceHealth(
  unitNames: readonly string[] = STATUS_SERVICE_UNIT_NAMES,
  dependencies: ServiceHealthDependencies = DEFAULT_SERVICE_HEALTH_DEPENDENCIES,
): Promise<ServiceHealthEntry[]> {
  const entries: ServiceHealthEntry[] = [];
  for (const unitName of unitNames) {
    entries.push(await readOneUnitHealth(unitName, dependencies));
  }
  return entries;
}
