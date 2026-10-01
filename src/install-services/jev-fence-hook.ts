import path from 'node:path';
import {
  registerHookInClaudeSettings,
  withToolUseHookRegistered,
  type JsonObject,
  type SettingsHookOutcome,
  type SettingsWithHookRegistered,
  type ToolUseHook,
} from './claude-settings-hook.ts';
import type {
  InstallServicesDeps,
  InstallServicesOptions,
} from './install-services.types.ts';

export const JEV_FENCE_HOOK: ToolUseHook = {
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
  return withToolUseHookRegistered(settings, JEV_FENCE_HOOK, command);
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
