import path from 'node:path';
import {
  installUnitFiles,
  isSystemdUnavailable,
  SYSTEMD_SOURCE_DIR,
  SYSTEMD_UNIT_NAMES,
  USER_UNIT_DIR,
} from '../install-services/service-unit-renderer.service.ts';
import type {
  InstallServicesDeps,
  InstallServicesOptions,
  InstallServicesResult,
} from './install-services.types.ts';
import {
  describeUnitInstallOutcome,
  writeInstallServicesLine,
} from './output.ts';

export interface LinuxUnitSpec {
  basename: string;
  enabledDirectly: boolean;
}

/**
 * The live herdr unit whose restart drops every agent pane. Was
 * `SYSTEMD_UNIT_NAMES.HERDR_SERVER` before the Ist campaign retired it in
 * favor of `THRONE_HERDR` — kept as the same named export so the
 * `changedWhileRunning` warning below still points at whichever unit is
 * actually live, not a retired name nothing will ever match again.
 */
export const HERDR_SERVER_UNIT = SYSTEMD_UNIT_NAMES.THRONE_HERDR;

/**
 * Every unit whose template embeds `{{HERDR_BIN}}` — gated behind the same
 * "herdr-decouple" feature flag, since installLinuxServices is handed `null`
 * for herdrBin when the flag is off and rendering any of these would then
 * throw on an unresolved token. `herdr-server.service` is retired (see
 * `RETIRED_LINUX_UNITS`) and no longer appears in `LINUX_UNITS`, so
 * `throne-herdr.service` — its consolidated-name counterpart, same
 * ExecStart shape — is the only entry left here.
 */
export const HERDR_BIN_DEPENDENT_UNITS: readonly string[] = [
  SYSTEMD_UNIT_NAMES.THRONE_HERDR,
];

/**
 * Ist campaign (2026-08-14): the court's real unit set is
 * `throne-herdr.service` + `throne-backend.service`, nothing else.
 * `herdr-server.service`, the keep-going/no-idling pairs, and
 * `throne-work.service` all moved to `RETIRED_LINUX_UNITS` below — they must
 * never be rendered, installed, or enabled again. Enabling a second herdr
 * server or a duplicate dispatch loop alongside the live ones is exactly the
 * incident this campaign exists to prevent. `ntfy.service` is unrelated to
 * the herdr/dispatch consolidation and keeps its prior behavior unchanged.
 */
export const LINUX_UNITS: readonly LinuxUnitSpec[] = [
  { basename: SYSTEMD_UNIT_NAMES.NTFY, enabledDirectly: true },
  { basename: SYSTEMD_UNIT_NAMES.THRONE_BACKEND, enabledDirectly: true },
  { basename: SYSTEMD_UNIT_NAMES.THRONE_HERDR, enabledDirectly: true },
  // Each scratch-sweep pair follows throne-keep-going's old timer+oneshot
  // shape exactly: the .service is never enabled directly (it has no
  // [Install] section of its own to act on), only its .timer is — the
  // timer is what systemd actually arms and what fires the service.
  { basename: SYSTEMD_UNIT_NAMES.SWEEP_TMP_SCRATCH_HOME_SERVICE, enabledDirectly: false },
  { basename: SYSTEMD_UNIT_NAMES.SWEEP_TMP_SCRATCH_HOME_TIMER, enabledDirectly: true },
  { basename: SYSTEMD_UNIT_NAMES.SWEEP_TMP_SCRATCH_SLASH_SERVICE, enabledDirectly: false },
  { basename: SYSTEMD_UNIT_NAMES.SWEEP_TMP_SCRATCH_SLASH_TIMER, enabledDirectly: true },
  { basename: SYSTEMD_UNIT_NAMES.SWEEP_TMP_SCRATCH_CLAUDE1000_SERVICE, enabledDirectly: false },
  { basename: SYSTEMD_UNIT_NAMES.SWEEP_TMP_SCRATCH_CLAUDE1000_TIMER, enabledDirectly: true },
];

/**
 * Units this install no longer manages, retired the same way BCL retired
 * `throne-build.service`: stop, disable, remove the unit file, idempotent,
 * dry-run-safe (see `retireLinuxUnit` below). Every basename here MUST stay
 * out of `LINUX_UNITS` — installing a unit and retiring it in the same run
 * would recreate the file `retireLinuxUnit` just removed.
 *
 * - `BUILD_SERVICE`: BCL campaign — its watch-rebuild role is now
 *   `SelfRebuildHostedWorker`, hosted inside `throne-backend` itself.
 * - `HERDR_SERVER`: Ist campaign — superseded by `THRONE_HERDR`; enabling
 *   both would start a second herdr server alongside the live one.
 * - `KEEP_GOING_SERVICE`/`KEEP_GOING_TIMER`, `NO_IDLING_SERVICE`/
 *   `NO_IDLING_TIMER`, `THRONE_WORK`: Ist campaign — the dispatch loop these
 *   drove now lives inside `throne-backend`; re-enabling any of them stands
 *   up a duplicate dispatch loop delivering messages twice into live agent
 *   panes.
 */
export const RETIRED_LINUX_UNITS: readonly string[] = [
  SYSTEMD_UNIT_NAMES.BUILD_SERVICE,
  SYSTEMD_UNIT_NAMES.HERDR_SERVER,
  SYSTEMD_UNIT_NAMES.KEEP_GOING_TIMER,
  SYSTEMD_UNIT_NAMES.KEEP_GOING_SERVICE,
  SYSTEMD_UNIT_NAMES.NO_IDLING_TIMER,
  SYSTEMD_UNIT_NAMES.NO_IDLING_SERVICE,
  SYSTEMD_UNIT_NAMES.THRONE_WORK,
];

/**
 * Stops, disables, and removes a unit this install no longer manages —
 * best-effort and idempotent, so a box that never had the unit, or one
 * already fully retired, sees no error and no output. Runs BEFORE the
 * ordinary render/enable pass so a freshly-installed `throne-backend`
 * (which now owns the retired unit's job) never races a still-enabled
 * `throne-build.service` racing it to rebuild the same `dist`.
 */
export async function retireLinuxUnit(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
  basename: string,
): Promise<{ retired: boolean }> {
  const active = await deps.systemctl(['--user', 'is-active', '--quiet', basename]);
  if (isSystemdUnavailable(active)) {
    return { retired: false };
  }
  const enabled = await deps.systemctl(['--user', 'is-enabled', basename]);
  const targetPath = path.join(USER_UNIT_DIR, basename);
  const installedUnit = await deps.inspectInstalledUnit(targetPath);
  const isActive = active.code === 0;
  const isEnabled = enabled.code === 0;
  const isInstalled = installedUnit.kind !== 'missing';
  if (!isActive && !isEnabled && !isInstalled) {
    return { retired: false }; // nothing to do -- never installed, or already fully retired
  }
  if (options.dryRun) {
    writeInstallServicesLine(`would retire ${basename} (stop, disable, remove unit file)`);
    return { retired: true };
  }
  if (isActive) {
    const result = await deps.systemctl(['--user', 'stop', basename]);
    if (result.code !== 0) {
      process.stderr.write(
        `install-services: failed to stop retired unit ${basename}: ${result.stderr.trim() || `exit ${result.code}`}\n`,
      );
    } else {
      writeInstallServicesLine(`retired ${basename}: stopped`);
    }
  }
  if (isEnabled) {
    const result = await deps.systemctl(['--user', 'disable', basename]);
    if (result.code !== 0) {
      process.stderr.write(
        `install-services: failed to disable retired unit ${basename}: ${result.stderr.trim() || `exit ${result.code}`}\n`,
      );
    } else {
      writeInstallServicesLine(`retired ${basename}: disabled`);
    }
  }
  if (isInstalled) {
    await deps.removeUnitFile(targetPath);
    writeInstallServicesLine(`retired ${basename}: removed unit file`);
  }
  if (isActive || isEnabled || isInstalled) {
    await deps.systemctl(['--user', 'daemon-reload']);
  }
  return { retired: true };
}

interface UnitRuntimeState {
  enabled: boolean;
  active: boolean;
}

async function inspectLinuxUnitStates(
  deps: InstallServicesDeps,
  units: readonly LinuxUnitSpec[],
): Promise<Map<string, UnitRuntimeState> | null> {
  const states = new Map<string, UnitRuntimeState>();
  for (const spec of units) {
    const active = await deps.systemctl([
      '--user',
      'is-active',
      '--quiet',
      spec.basename,
    ]);
    if (isSystemdUnavailable(active)) {
      writeInstallServicesLine(
        'systemd --user unavailable; skipping service installation',
      );
      return null;
    }
    const enabled = await deps.systemctl([
      '--user',
      'is-enabled',
      spec.basename,
    ]);
    states.set(spec.basename, {
      active: active.code === 0,
      enabled: enabled.code === 0,
    });
  }
  return states;
}

export async function installLinuxServices(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
  herdrBin: string | null,
  units: readonly LinuxUnitSpec[],
  // Defaults to none: this function is also exercised directly against
  // synthetic unit lists (`linux.spec.ts`) that must see zero retirement
  // side effects. Only `install-services.ts`'s real-unit call site passes
  // `RETIRED_LINUX_UNITS`.
  retiredUnitBasenames: readonly string[] = [],
): Promise<InstallServicesResult> {
  const stateBefore = await inspectLinuxUnitStates(deps, units);
  if (stateBefore === null) {
    return {
      code: 0,
      status: 'skipped-no-systemd',
      changedWhileRunning: [],
    };
  }

  // Retirement runs only once systemd is confirmed reachable above -- reusing
  // that same proof rather than probing is-active a second time, which would
  // turn the "systemd unavailable" skip path into two probes instead of one.
  for (const basename of retiredUnitBasenames) {
    try {
      await retireLinuxUnit(deps, options, basename);
    } catch (error) {
      process.stderr.write(
        `install-services: retiring ${basename} failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  const outcomes = await installUnitFiles(
    deps,
    units.map((spec) => ({
      sourcePath: path.join(SYSTEMD_SOURCE_DIR, spec.basename),
      targetPath: path.join(USER_UNIT_DIR, spec.basename),
      tokens: {
        throneRoot: options.throneRoot,
        herdrBin,
        nodeBin: deps.resolveNodeBin(),
      },
      dryRun: options.dryRun,
    })),
  );
  for (const outcome of outcomes) {
    writeInstallServicesLine(
      options.dryRun
        ? `would ${describeUnitInstallOutcome(outcome)}`
        : describeUnitInstallOutcome(outcome),
    );
  }

  const changedWhileRunning = outcomes
    .filter(
      (outcome) =>
        outcome.changed &&
        stateBefore.get(outcome.basename)?.active === true,
    )
    .map((outcome) => outcome.basename);
  for (const basename of changedWhileRunning) {
    writeInstallServicesLine(
      `${basename}: installed content changed while the unit was running. ` +
        `Nothing was restarted, stopped or killed` +
        (basename === HERDR_SERVER_UNIT
          ? ' (a restart drops every live agent pane)'
          : '') +
        '; applying the new content is an operator decision.',
    );
  }

  const mutations: string[][] = [];
  if (outcomes.some((outcome) => outcome.changed)) {
    mutations.push(['--user', 'daemon-reload']);
  }
  for (const spec of units) {
    const outcome = outcomes.find(
      (candidate) => candidate.basename === spec.basename,
    );
    const state = stateBefore.get(spec.basename);
    if (
      !spec.enabledDirectly ||
      outcome?.action === 'error' ||
      state === undefined
    ) {
      continue;
    }
    if (!state.enabled || !state.active) {
      mutations.push(['--user', 'enable', '--now', spec.basename]);
    }
  }

  if (options.dryRun) {
    for (const argv of mutations) {
      writeInstallServicesLine(`would run: systemctl ${argv.join(' ')}`);
    }
    if (mutations.length === 0) {
      writeInstallServicesLine(
        'would run no systemctl commands (everything already installed and enabled)',
      );
    }
    return { code: 0, status: 'dry-run', changedWhileRunning };
  }

  const failures = outcomes
    .filter((outcome) => outcome.action === 'error')
    .map((outcome) => outcome.basename);
  for (const argv of mutations) {
    const result = await deps.systemctl(argv);
    if (result.code !== 0) {
      process.stderr.write(
        `install-services: systemctl ${argv.join(' ')} failed: ` +
          `${result.stderr.trim() || `exited ${result.code}`}\n`,
      );
      failures.push(argv.join(' '));
      continue;
    }
    writeInstallServicesLine(`ran: systemctl ${argv.join(' ')}`);
  }

  if (failures.length > 0) {
    return { code: 1, status: 'error', changedWhileRunning };
  }
  if (mutations.length === 0) {
    writeInstallServicesLine(
      'everything already installed and enabled; nothing to do',
    );
    return { code: 0, status: 'unchanged', changedWhileRunning };
  }
  return { code: 0, status: 'installed', changedWhileRunning };
}
