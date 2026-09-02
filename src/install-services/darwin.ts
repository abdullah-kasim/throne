import path from 'node:path';
import {
  installUnitFiles,
  LAUNCH_AGENTS_DIR,
  LAUNCHD_AGENT_NAMES,
  LAUNCHD_SOURCE_DIR,
  SERVICE_MANAGER_ABSENT,
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

export interface DarwinAgentSpec {
  basename: string;
  label: string;
  /**
   * False for a template that install-services must render and install but
   * never enable/bootstrap on its own — mirrors LinuxUnitSpec.enabledDirectly.
   * Defaults to true.
   */
  enabledDirectly?: boolean;
}

/**
 * The live herdr agent whose reload drops every agent pane. Was
 * `LAUNCHD_AGENT_NAMES.HERDR_SERVER` until the mac side caught up with the
 * linux Ist consolidation (2026-09-02) — kept as the same named export so the
 * `changedWhileRunning` warning below points at the agent that is actually
 * live.
 */
export const HERDR_SERVER_AGENT =
  LAUNCHD_AGENT_NAMES.THRONE_HERDR.basename;

/** The darwin counterpart of linux.ts's HERDR_BIN_DEPENDENT_UNITS. */
export const HERDR_BIN_DEPENDENT_AGENTS: readonly string[] = [
  LAUNCHD_AGENT_NAMES.THRONE_HERDR.basename,
];

/**
 * The mac agent set, brought level with `LINUX_UNITS` (2026-09-02, the first
 * time a real mac ran this): `com.throne.throne-herdr` + `com.throne.throne-backend`
 * are the court, and `com.throne.ntfy` the phone-notification server — all
 * three enabled and bootstrapped, exactly as on linux. `systemd/ntfy-serve`
 * is platform-aware (ifconfig, the Tailscale.app CLI) and `ntfy` is the brew
 * formula ./install.sh installs. The three linux `sweep-tmp-scratch` timer
 * pairs have no mac counterpart: they exist for a tmpfs per-uid inode cap
 * that macOS does not impose.
 */
export const DARWIN_AGENTS: readonly DarwinAgentSpec[] = [
  LAUNCHD_AGENT_NAMES.NTFY,
  LAUNCHD_AGENT_NAMES.THRONE_BACKEND,
  LAUNCHD_AGENT_NAMES.THRONE_HERDR,
];

/**
 * The mac counterpart of `RETIRED_LINUX_UNITS`: agents this install no
 * longer manages, torn down (bootout + plist removal) before the ordinary
 * render/enable pass so a box that installed the pre-consolidation set never
 * runs two herdr servers or a duplicate dispatch loop next to throne-backend.
 * Every entry here MUST stay out of `DARWIN_AGENTS`.
 */
export const RETIRED_DARWIN_AGENTS: readonly DarwinAgentSpec[] = [
  LAUNCHD_AGENT_NAMES.HERDR_SERVER,
  LAUNCHD_AGENT_NAMES.KEEP_GOING,
  LAUNCHD_AGENT_NAMES.NO_IDLING,
];

/**
 * Boots out and removes a retired agent — best-effort and idempotent, so a
 * box that never had it, or one already fully retired, sees no output.
 * `launchctl disable` is deliberately NOT issued: launchd persists a disabled
 * label across reboots, which would silently block any future bootstrap of
 * the same label. Bootout plus removing the plist is the whole retirement.
 */
export async function retireDarwinAgent(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
  spec: DarwinAgentSpec,
): Promise<{ retired: boolean }> {
  const domainTarget = `gui/${deps.userId()}`;
  const printed = await deps.launchctl(['print', `${domainTarget}/${spec.label}`]);
  if (printed.code === SERVICE_MANAGER_ABSENT) {
    return { retired: false };
  }
  const isLoaded = printed.code === 0;
  const targetPath = path.join(LAUNCH_AGENTS_DIR, spec.basename);
  const installed = await deps.inspectInstalledUnit(targetPath);
  const isInstalled = installed.kind !== 'missing';
  if (!isLoaded && !isInstalled) {
    return { retired: false };
  }
  if (options.dryRun) {
    writeInstallServicesLine(`would retire ${spec.basename} (bootout, remove plist)`);
    return { retired: true };
  }
  if (isLoaded) {
    // MEASURED on a real mac (2026-09-02): bootout returns 0 before the
    // service is actually gone — a `launchctl print` issued immediately
    // afterwards still succeeds for a moment. Nothing here re-probes, so
    // the race is harmless; do not add a post-bootout assertion.
    const result = await deps.launchctl(['bootout', `${domainTarget}/${spec.label}`]);
    if (result.code !== 0) {
      process.stderr.write(
        `install-services: failed to boot out retired agent ${spec.label}: ${result.stderr.trim() || `exit ${result.code}`}\n`,
      );
    } else {
      writeInstallServicesLine(`retired ${spec.basename}: booted out`);
    }
  }
  if (isInstalled) {
    await deps.removeUnitFile(targetPath);
    writeInstallServicesLine(`retired ${spec.basename}: removed plist`);
  }
  return { retired: true };
}

export async function installDarwinServices(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
  herdrBin: string | null,
  agents: readonly DarwinAgentSpec[],
  // Defaults to none, like installLinuxServices: only install-services.ts's
  // real call site passes RETIRED_DARWIN_AGENTS.
  retiredAgents: readonly DarwinAgentSpec[] = [],
): Promise<InstallServicesResult> {
  const domainTarget = `gui/${deps.userId()}`;
  const serviceTarget = (label: string): string =>
    `${domainTarget}/${label}`;

  const loadedBefore = new Map<string, boolean>();
  for (const spec of agents) {
    const printed = await deps.launchctl([
      'print',
      serviceTarget(spec.label),
    ]);
    if (printed.code === SERVICE_MANAGER_ABSENT) {
      process.stderr.write(
        'install-services: launchctl could not be run. This command treats that ' +
          'as a broken mac rather than a mac without user services, so it ' +
          'refuses instead of skipping; nothing was installed\n',
      );
      return {
        code: 1,
        status: 'error-no-launchctl',
        changedWhileRunning: [],
      };
    }
    loadedBefore.set(spec.basename, printed.code === 0);
  }

  // Retirement runs only once launchctl is confirmed reachable above.
  for (const spec of retiredAgents) {
    try {
      await retireDarwinAgent(deps, options, spec);
    } catch (error) {
      process.stderr.write(
        `install-services: retiring ${spec.basename} failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  const outcomes = await installUnitFiles(
    deps,
    agents.map((spec) => ({
      sourcePath: path.join(LAUNCHD_SOURCE_DIR, spec.basename),
      targetPath: path.join(LAUNCH_AGENTS_DIR, spec.basename),
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
        loadedBefore.get(outcome.basename) === true,
    )
    .map((outcome) => outcome.basename);
  for (const basename of changedWhileRunning) {
    writeInstallServicesLine(
      `${basename}: installed content changed while the agent was loaded. ` +
        `Nothing was booted out, kickstarted or killed` +
        (basename === HERDR_SERVER_AGENT
          ? ' (a reload drops every live agent pane)'
          : '') +
        '; applying the new content is an operator decision.',
    );
  }

  const mutations: string[][] = [];
  for (const spec of agents) {
    const outcome = outcomes.find(
      (candidate) => candidate.basename === spec.basename,
    );
    if (
      outcome === undefined ||
      outcome.action === 'error' ||
      spec.enabledDirectly === false
    ) {
      continue;
    }
    if (loadedBefore.get(spec.basename) === true) {
      continue;
    }
    mutations.push(['enable', serviceTarget(spec.label)]);
    mutations.push([
      'bootstrap',
      domainTarget,
      path.join(LAUNCH_AGENTS_DIR, spec.basename),
    ]);
  }

  if (options.dryRun) {
    for (const argv of mutations) {
      writeInstallServicesLine(`would run: launchctl ${argv.join(' ')}`);
    }
    if (mutations.length === 0) {
      writeInstallServicesLine(
        'would run no launchctl commands (every agent already installed and loaded)',
      );
    }
    return { code: 0, status: 'dry-run', changedWhileRunning };
  }

  const failures = outcomes
    .filter((outcome) => outcome.action === 'error')
    .map((outcome) => outcome.basename);
  for (const argv of mutations) {
    const result = await deps.launchctl(argv);
    if (result.code !== 0) {
      process.stderr.write(
        `install-services: launchctl ${argv.join(' ')} failed: ` +
          `${result.stderr.trim() || `exited ${result.code}`}\n`,
      );
      failures.push(argv.join(' '));
      continue;
    }
    writeInstallServicesLine(`ran: launchctl ${argv.join(' ')}`);
  }

  if (failures.length > 0) {
    return { code: 1, status: 'error', changedWhileRunning };
  }
  if (mutations.length === 0) {
    writeInstallServicesLine(
      'every agent already installed and loaded; nothing to do',
    );
    return { code: 0, status: 'unchanged', changedWhileRunning };
  }
  return { code: 0, status: 'installed', changedWhileRunning };
}
