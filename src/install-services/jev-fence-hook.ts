import path from 'node:path';
import {
  registerHookInClaudeSettings,
  withClaudeHookRegistered,
  type JsonObject,
  type SettingsHookOutcome,
  type SettingsWithHookRegistered,
  type ClaudeSettingsHook,
} from './claude-settings-hook.ts';
import type {
  InstallServicesDeps,
  InstallServicesOptions,
} from './install-services.types.ts';

export const JEV_FENCE_HOOK: ClaudeSettingsHook = {
  event: 'PreToolUse',
  matcher: 'Bash|Read|Grep|Write|Edit|MultiEdit',
  hookFileName: 'jev-fence.py',
};

export function jevFenceHookCommand(throneRoot: string): string {
  const hookPath = path.join(throneRoot, 'claude-hooks', JEV_FENCE_HOOK.hookFileName);
  return `python3 "${hookPath}"`;
}

export function withJevFenceRegistered(
  settings: JsonObject,
  command: string,
): SettingsWithHookRegistered {
  return withClaudeHookRegistered(settings, JEV_FENCE_HOOK, command);
}

export async function installJevFenceHook(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<SettingsHookOutcome> {
  return registerHookInClaudeSettings(
    deps,
    options,
    'jev fence hook',
    (settings) => withJevFenceRegistered(settings, jevFenceHookCommand(options.throneRoot)),
  );
}
