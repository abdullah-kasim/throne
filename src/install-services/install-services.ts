import path from 'node:path';
import { THRONE_ROOT } from '../install-services/service-unit-renderer.service.ts';
import { isMainCheckoutRoot } from '../shared-policy/runtime-throne-root.ts';
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';
import {
  type InstallServicesDeps,
  type InstallServicesOptions,
  type InstallServicesResult,
  type InstallServicesStatus,
} from './install-services.types.ts';
import {
  DARWIN_AGENTS,
  HERDR_BIN_DEPENDENT_AGENTS,
  installDarwinServices,
  RETIRED_DARWIN_AGENTS,
} from './darwin.ts';
import {
  CODEX_HOOK_TARGET_PATH,
  CODEX_HOOK_TEMPLATE_PATH,
  installCodexHookRegistration,
  installThroneCommand,
  resolveCodexHookTargetPath,
  type ThroneCommandOutcome,
} from './hook-and-command.ts';
import { prepareOwnedHerdr } from './herdr-installation.ts';
import { writeInstallServicesLine } from './output.ts';
import { REAL_DEPS } from './platform.ts';
import {
  HERDR_BIN_DEPENDENT_UNITS,
  installLinuxServices,
  LINUX_UNITS,
  RETIRED_LINUX_UNITS,
} from './linux.ts';

export {
  CODEX_HOOK_TARGET_PATH,
  CODEX_HOOK_TEMPLATE_PATH,
  resolveCodexHookTargetPath,
  REAL_DEPS,
};
export type {
  InstallServicesDeps,
  InstallServicesOptions,
  InstallServicesResult,
  InstallServicesStatus,
};

/**
 * Self-heals the on-PATH `throne` and `throne-cli` symlinks so each bare
 * command always resolves to its live-root dispatcher. Bare `throne`
 * dispatcher script: no arguments opens/attaches the herdr session, any
 * arguments forward straight through to the CLI (`throne <subcommand>`
 * keeps working exactly as before the split). Created if absent, repointed
 * if it's a symlink pointing anywhere else, and left alone (with a warning)
 * if it exists and is not a symlink at all — never clobbering unknown real
 * content. Best-effort: failures here never fail the overall install-services
 * run.
 */
export async function ensurePathSymlinks(
  options: InstallServicesOptions,
  deps: InstallServicesDeps,
): Promise<void> {
  for (const targetPath of deps.pathSymlinkTargets()) {
    const commandName = path.basename(targetPath);
    const sourcePath = path.join(options.throneRoot, 'bin', commandName);
    const installed = await deps.inspectPathSymlink(targetPath);
    if (installed.kind === 'symlink' && installed.target === sourcePath) {
      writeInstallServicesLine(`${commandName} symlink: unchanged → ${targetPath}`);
      continue;
    }
    if (installed.kind === 'file') {
      process.stderr.write(
        `install-services: ${commandName} symlink self-heal skipped ${targetPath}; ` +
          'it exists and is not a symlink, leaving it alone\n',
      );
      continue;
    }
    const verb = installed.kind === 'missing' ? 'install' : 'repoint';
    if (options.dryRun) {
      writeInstallServicesLine(
        `would ${verb} ${commandName} symlink → ${targetPath} (symlink to ${sourcePath})`,
      );
      continue;
    }
    await deps.writePathSymlink(sourcePath, targetPath);
    writeInstallServicesLine(
      `${commandName} symlink: ${verb === 'install' ? 'installed' : 'repointed'} → ${targetPath}`,
    );
  }
}

export async function installServices(
  options: InstallServicesOptions,
  deps: InstallServicesDeps = REAL_DEPS,
): Promise<InstallServicesResult> {
  // Worktree-refusal guard (Regent hard requirement, 2026-08-11): a live
  // incident baked a reaped campaign worktree's transient path into
  // `throne-work.service`'s WorkingDirectory/ExecStart, which could not have
  // survived a reboot. Refuse loudly, before any unit is rendered or
  // written, when the resolved root is not the live main checkout — unless
  // the caller passed `--throne-root` explicitly, a deliberate opt-out for
  // a genuinely non-default install. This check runs first, ahead of every
  // other side effect in this function.
  if (!options.throneRootExplicit && !isMainCheckoutRoot(options.throneRoot)) {
    process.stderr.write(
      `install-services: refusing to run from "${options.throneRoot}" — ` +
        'it is a linked worktree, not the live main throne checkout (its ' +
        '".git" is a file, not a directory). Installing services from a ' +
        'worktree bakes that worktree\'s transient path into the unit ' +
        'files; the worktree is later reaped and deleted, and the service ' +
        'cannot survive its next restart. Remedy: run install-services ' +
        'from the live main checkout, or pass --throne-root explicitly if ' +
        'this is a genuinely intentional non-default install.\n',
    );
    return { code: 1, status: 'error', changedWhileRunning: [] };
  }
  if (deps.platform !== 'linux' && deps.platform !== 'darwin') {
    process.stderr.write(
      `install-services: unsupported platform ${deps.platform}; ` +
        'the throne installs services on linux (systemd --user) and mac (launchd) only\n',
    );
    return {
      code: 1,
      status: 'unsupported-platform',
      changedWhileRunning: [],
    };
  }

  const herdrDecouple = deps.herdrDecoupleEnabled();
  writeInstallServicesLine(
    `feature flag "herdr-decouple": ${herdrDecouple ? 'ON' : 'OFF'}`,
  );

  let herdrBin: string | null = null;
  if (herdrDecouple) {
    try {
      herdrBin = await prepareOwnedHerdr(deps, options);
    } catch (error) {
      process.stderr.write(
        `install-services: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return { code: 1, status: 'error', changedWhileRunning: [] };
    }
  } else {
    writeInstallServicesLine(
      'herdr decoupling disabled; preserving the existing client, throne command, and Herdr service',
    );
  }

  const hookOutcome = await installCodexHookRegistration(deps, options);
  try {
    await ensurePathSymlinks(options, deps);
  } catch (error) {
    process.stderr.write(
      `install-services: throne symlink self-heal failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
  let throneCommandOutcome: ThroneCommandOutcome | undefined;
  if (herdrDecouple) {
    try {
      throneCommandOutcome = await installThroneCommand(deps, options);
    } catch (error) {
      process.stderr.write(
        `install-services: throne command installation failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      throneCommandOutcome = 'collision';
    }
  }

  const linuxUnits = LINUX_UNITS.filter(
    (unit) =>
      herdrDecouple || !HERDR_BIN_DEPENDENT_UNITS.includes(unit.basename),
  );
  const darwinAgents = herdrDecouple
    ? DARWIN_AGENTS
    : DARWIN_AGENTS.filter(
        (agent) => !HERDR_BIN_DEPENDENT_AGENTS.includes(agent.basename),
      );

  let result: InstallServicesResult;
  try {
    result =
      deps.platform === 'linux'
        ? await installLinuxServices(
            deps,
            options,
            herdrBin,
            linuxUnits,
            RETIRED_LINUX_UNITS,
          )
        : await installDarwinServices(
            deps,
            options,
            herdrBin,
            darwinAgents,
            RETIRED_DARWIN_AGENTS,
          );
  } catch (error) {
    process.stderr.write(
      `install-services: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { code: 1, status: 'error', changedWhileRunning: [] };
  }

  if (
    hookOutcome.action === 'error' &&
    !options.dryRun &&
    result.code === 0
  ) {
    return { ...result, code: 1, status: 'error' };
  }
  if (throneCommandOutcome === 'collision' && result.code === 0) {
    return { ...result, code: 1, status: 'error' };
  }
  return result;
}

const DRY_RUN_FLAG = '--dry-run';
const THRONE_ROOT_FLAG = '--throne-root';
const OFFLINE_FLAG = '--offline';

export function parseInstallServicesArgs(
  args: string[],
): InstallServicesOptions {
  const options: InstallServicesOptions = {
    dryRun: false,
    throneRoot: THRONE_ROOT,
    throneRootExplicit: false,
    offline: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === DRY_RUN_FLAG) {
      options.dryRun = true;
      continue;
    }
    if (arg === OFFLINE_FLAG) {
      options.offline = true;
      continue;
    }
    if (arg === THRONE_ROOT_FLAG) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`${THRONE_ROOT_FLAG} needs an absolute path`);
      }
      if (!path.isAbsolute(value)) {
        throw new Error(
          `${THRONE_ROOT_FLAG} must be absolute (got "${value}")`,
        );
      }
      options.throneRoot = value;
      options.throneRootExplicit = true;
      index += 1;
      continue;
    }
    throw new Error(
      `unknown argument "${arg}"; usage: install-services [${DRY_RUN_FLAG}] [${OFFLINE_FLAG}] ` +
        `[${THRONE_ROOT_FLAG} <absolute path>]`,
    );
  }
  return options;
}

export async function run(
  args: string[],
  deps: InstallServicesDeps = REAL_DEPS,
): Promise<number> {
  let options: InstallServicesOptions;
  try {
    options = parseInstallServicesArgs(args);
  } catch (error) {
    process.stderr.write(
      `${renderEntranceRefusal({
        reason: `install-services entrance validation rejected the supplied service-install arguments: ${
          error instanceof Error ? error.message : String(error)
        }`,
        bypass: undefined,
        supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
      })}\n`,
    );
    return 1;
  }
  const { code } = await installServices(options, deps);
  return code;
}
