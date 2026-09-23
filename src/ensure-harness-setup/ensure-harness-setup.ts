import { installClaudeGuardHook } from '../install-services/claude-guard-hook.ts';
import { installCodexHookRegistration } from '../install-services/hook-and-command.ts';
import type {
  InstallServicesDeps,
  InstallServicesOptions,
} from '../install-services/install-services.types.ts';
import { withInstallServicesOutput } from '../install-services/output.ts';
import { REAL_DEPS } from '../install-services/platform.ts';
import { installSkillWriteGuardHook } from '../install-services/skill-write-guard-hook.ts';
import {
  NOTIFY_CONFIG,
  postNtfyMessage,
} from '../notify-lord/notification.service.ts';
import {
  isMainCheckoutRoot,
  RUNTIME_THRONE_ROOT,
} from '../shared-policy/runtime-throne-root.ts';

export type HookSetupState = 'unchanged' | 'added' | 'failed';

export interface HookSetupResult {
  hook: string;
  state: HookSetupState;
  reason?: string;
}

export interface EnsureHarnessSetupDependencies {
  installDeps: InstallServicesDeps;
  notifyLord: (message: string) => Promise<void>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}

export const NOTIFICATION_TITLE = 'Throne harness setup failed';

export const PRODUCTION_DEPENDENCIES: EnsureHarnessSetupDependencies = {
  installDeps: REAL_DEPS,
  notifyLord: (message) =>
    postNtfyMessage(message, NOTIFY_CONFIG, { title: NOTIFICATION_TITLE }),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

interface HookInstaller {
  hook: string;
  install: (
    deps: InstallServicesDeps,
    options: InstallServicesOptions,
  ) => Promise<{ state: HookSetupState; reason?: string }>;
}

const HOOK_INSTALLERS: readonly HookInstaller[] = [
  {
    hook: 'claude scratch path guard',
    install: async (deps, options) =>
      settingsHookState(await installClaudeGuardHook(deps, options)),
  },
  {
    hook: 'claude skill write guard',
    install: async (deps, options) =>
      settingsHookState(await installSkillWriteGuardHook(deps, options)),
  },
  {
    hook: 'codex session start',
    install: async (deps, options) => {
      const outcome = await installCodexHookRegistration(deps, options);
      if (outcome.action === 'unchanged') return { state: 'unchanged' };
      if (outcome.action === 'error') {
        return { state: 'failed', reason: outcome.message ?? 'unknown failure' };
      }
      return { state: 'added' };
    },
  },
];

function settingsHookState(
  outcome: 'unchanged' | 'registered' | 'replaced' | 'error',
): { state: HookSetupState } {
  if (outcome === 'unchanged') return { state: 'unchanged' };
  if (outcome === 'error') return { state: 'failed' };
  return { state: 'added' };
}

async function withInstallOutputHeld<T>(
  work: () => Promise<T>,
): Promise<{ value: T; errorOutput: string }> {
  let errorOutput = '';
  const value = await withInstallServicesOutput(
    {
      writeLine: () => {},
      writeError: (text) => {
        errorOutput += text;
      },
    },
    work,
  );
  return { value, errorOutput };
}

function heldOutputReason(errorOutput: string): string | undefined {
  const reason = errorOutput.replace(/^install-services: /gm, '').replace(/\s+/g, ' ').trim();
  return reason === '' ? undefined : reason;
}

export async function ensureHarnessHooks(
  throneRoot: string,
  installDeps: InstallServicesDeps,
): Promise<HookSetupResult[]> {
  const options: InstallServicesOptions = {
    dryRun: false,
    throneRoot,
    throneRootExplicit: true,
  };
  const results: HookSetupResult[] = [];
  for (const installer of HOOK_INSTALLERS) {
    try {
      const { value, errorOutput } = await withInstallOutputHeld(() =>
        installer.install(installDeps, options),
      );
      const reason = value.reason ?? heldOutputReason(errorOutput);
      results.push(
        value.state === 'failed'
          ? { hook: installer.hook, state: 'failed', reason: reason ?? 'unknown failure' }
          : { hook: installer.hook, state: value.state },
      );
    } catch (error) {
      results.push({
        hook: installer.hook,
        state: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export function describeHookSetupResult(result: HookSetupResult): string {
  return result.state === 'failed'
    ? `${result.hook}: failed: ${result.reason}`
    : `${result.hook}: ${result.state}`;
}

export function failureNotification(
  throneRoot: string,
  failures: readonly HookSetupResult[],
): string {
  return [
    `Throne could not register its harness hooks for ${throneRoot}:`,
    ...failures.map(describeHookSetupResult),
  ].join('\n');
}

export async function ensureHarnessSetup(
  throneRoot: string,
  dependencies: EnsureHarnessSetupDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  const results = await ensureHarnessHooks(throneRoot, dependencies.installDeps);
  for (const result of results) {
    const line = `ensure-harness-setup: ${describeHookSetupResult(result)}\n`;
    if (result.state === 'failed') dependencies.writeStderr(line);
    else dependencies.writeStdout(line);
  }
  const failures = results.filter((result) => result.state === 'failed');
  if (failures.length === 0) return 0;
  try {
    await dependencies.notifyLord(failureNotification(throneRoot, failures));
  } catch (error) {
    dependencies.writeStderr(
      `ensure-harness-setup: could not notify the Lord: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
  return 1;
}

export function parseThroneRoot(
  args: readonly string[],
  defaultThroneRoot: string = RUNTIME_THRONE_ROOT,
): string | Error {
  let throneRoot: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--throne-root') {
      const value = args[index + 1];
      if (value === undefined || value === '') {
        return new Error('--throne-root needs a path');
      }
      throneRoot = value;
      index += 1;
    } else if (argument.startsWith('--throne-root=')) {
      throneRoot = argument.slice('--throne-root='.length);
    } else {
      return new Error(`unknown argument "${argument}"`);
    }
  }
  if (throneRoot !== undefined) return throneRoot;
  if (!isMainCheckoutRoot(defaultThroneRoot)) {
    return new Error(
      `"${defaultThroneRoot}" is a linked worktree, not the live throne checkout; pass --throne-root to name the root to register`,
    );
  }
  return defaultThroneRoot;
}

export async function runEnsureHarnessSetup(
  args: readonly string[],
  dependencies: EnsureHarnessSetupDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  const throneRoot = parseThroneRoot(args);
  if (throneRoot instanceof Error) {
    dependencies.writeStderr(
      `ensure-harness-setup: ${throneRoot.message}. Usage: throne ensure-harness-setup [--throne-root <path>]\n`,
    );
    return 2;
  }
  return ensureHarnessSetup(throneRoot, dependencies);
}
