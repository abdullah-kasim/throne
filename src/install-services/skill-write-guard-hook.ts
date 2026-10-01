import path from 'node:path';
import {
  registerHookInClaudeSettings,
  withToolUseHookRegistered,
  type JsonObject,
  type SettingsHookOutcome,
  type ToolUseHook,
  type SettingsWithHookRegistered,
} from './claude-settings-hook.ts';
import type {
  InstallServicesDeps,
  InstallServicesOptions,
} from './install-services.types.ts';

const SKILL_WRITE_GUARD_HOOK: ToolUseHook = {
  event: 'PostToolUse',
  matcher: 'Edit|Write',
  hookFileName: 'skill-write-guard.py',
};

export function skillWriteGuardHookCommand(throneRoot: string): string {
  const hookPath = path.join(throneRoot, 'claude-hooks', SKILL_WRITE_GUARD_HOOK.hookFileName);
  return `python3 "${hookPath}"`;
}

export function withSkillWriteGuardRegistered(
  settings: JsonObject,
  command: string,
): SettingsWithHookRegistered {
  return withToolUseHookRegistered(settings, SKILL_WRITE_GUARD_HOOK, command);
}

export async function installSkillWriteGuardHook(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<SettingsHookOutcome> {
  return registerHookInClaudeSettings(
    deps,
    options,
    'skill write guard hook',
    (settings) =>
      withSkillWriteGuardRegistered(settings, skillWriteGuardHookCommand(options.throneRoot)),
  );
}
