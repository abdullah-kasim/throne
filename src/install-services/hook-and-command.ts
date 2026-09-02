import path from 'node:path';
import {
  installUnitFile,
  THRONE_ROOT,
  type UnitInstallOutcome,
} from '../install-services/service-unit-renderer.service.ts';
import type {
  InstallServicesDeps,
  InstallServicesOptions,
} from './install-services.types.ts';
import {
  describeUnitInstallOutcome,
  writeInstallServicesLine,
} from './output.ts';

// The template always ships from the running checkout (whichever checkout's
// bin/tools.js you invoked install-services through) — same rule as
// SYSTEMD_SOURCE_DIR for unit sources. It is never parameterized by
// options.throneRoot.
export const CODEX_HOOK_TEMPLATE_PATH = path.join(
  THRONE_ROOT,
  '.codex',
  'hooks.json.template',
);

/**
 * Where the rendered hook lands: `.codex/hooks.json` inside the TARGET
 * checkout, i.e. `throneRoot` — a checkout-local artifact, so a deliberate
 * `--throne-root <other checkout>` install must write it there, not into the
 * running module's own checkout. Fix (Ist campaign, 2026-08-14, Regent
 * review): this used to be a module constant pinned to THRONE_ROOT exactly
 * like CODEX_HOOK_TEMPLATE_PATH, so `--throne-root` was honoured for every
 * systemd unit's rendered content but silently ignored for hooks.json —
 * a flag partly obeyed reads as fully obeyed to the operator, which is worse
 * than not existing.
 */
export function resolveCodexHookTargetPath(throneRoot: string): string {
  return path.join(throneRoot, '.codex', 'hooks.json');
}

/** The default-root form, kept as a constant for callers that only ever ran against THRONE_ROOT. */
export const CODEX_HOOK_TARGET_PATH = resolveCodexHookTargetPath(THRONE_ROOT);

export type ThroneCommandOutcome =
  | 'created'
  | 'unchanged'
  | 'dry-run'
  | 'collision';

export async function installCodexHookRegistration(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<UnitInstallOutcome> {
  const outcome = await installUnitFile(deps, {
    sourcePath: CODEX_HOOK_TEMPLATE_PATH,
    targetPath: resolveCodexHookTargetPath(options.throneRoot),
    tokens: { throneRoot: options.throneRoot, herdrBin: null },
    dryRun: options.dryRun,
  });
  writeInstallServicesLine(
    options.dryRun
      ? `would ${describeUnitInstallOutcome(outcome)}`
      : describeUnitInstallOutcome(outcome),
  );
  return outcome;
}

export async function installThroneCommand(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<ThroneCommandOutcome> {
  // Same target as ensurePathSymlinks' legacy `~/.local/bin/throne` entry —
  // both must agree on the source, or the two self-healers permanently
  // fight over the symlink and install-services can never report success
  // while herdr-decouple is ON. bin/throne is the dispatcher (no args opens
  // the session, any args forward to the CLI), so PATH `throne` gets both.
  const sourcePath = path.join(options.throneRoot, 'bin', 'throne');
  const targetPath = deps.throneCommandPath();
  const installed = await deps.inspectThroneCommand(targetPath);
  if (installed.kind === 'symlink' && installed.target === sourcePath) {
    writeInstallServicesLine(`throne command: unchanged → ${targetPath}`);
    return 'unchanged';
  }
  if (installed.kind !== 'missing') {
    process.stderr.write(
      `install-services: throne command collision at ${targetPath}; preserving the unrelated ` +
        `${installed.kind}${installed.target === undefined ? '' : ` targeting ${installed.target}`}\n`,
    );
    return 'collision';
  }
  if (options.dryRun) {
    writeInstallServicesLine(
      `would install throne command → ${targetPath} (symlink to ${sourcePath})`,
    );
    return 'dry-run';
  }
  await deps.createThroneCommandSymlink(sourcePath, targetPath);
  writeInstallServicesLine(`throne command: installed → ${targetPath}`);
  return 'created';
}
