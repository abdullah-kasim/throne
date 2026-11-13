import path from 'node:path';
import {
  registerHookInClaudeSettings,
  withClaudeHooksRegistered,
  type ClaudeSettingsHook,
  type JsonObject,
  type SettingsHookOutcome,
  type SettingsWithHookRegistered,
} from './claude-settings-hook.ts';
import type {
  InstallServicesDeps,
  InstallServicesOptions,
} from './install-services.types.ts';

const HIDDEN_SKILL_POINTER_HOOK_FILE_NAME = 'hidden-skill-pointer.py';

const HIDDEN_SKILL_POINTER_HOOKS: readonly ClaudeSettingsHook[] = [
  { event: 'UserPromptSubmit', hookFileName: HIDDEN_SKILL_POINTER_HOOK_FILE_NAME },
  { event: 'PreToolUse', matcher: 'Skill', hookFileName: HIDDEN_SKILL_POINTER_HOOK_FILE_NAME },
  { event: 'PostToolUse', matcher: 'Skill', hookFileName: HIDDEN_SKILL_POINTER_HOOK_FILE_NAME },
  { event: 'PostToolUse', matcher: 'Read', hookFileName: HIDDEN_SKILL_POINTER_HOOK_FILE_NAME },
];

export function hiddenSkillPointerHookCommand(throneRoot: string): string {
  const hookPath = path.join(throneRoot, 'claude-hooks', HIDDEN_SKILL_POINTER_HOOK_FILE_NAME);
  return `python3 "${hookPath}"`;
}

export function withHiddenSkillPointerRegistered(
  settings: JsonObject,
  command: string,
): SettingsWithHookRegistered {
  return withClaudeHooksRegistered(settings, HIDDEN_SKILL_POINTER_HOOKS, command);
}

export async function installHiddenSkillPointerHook(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<SettingsHookOutcome> {
  return registerHookInClaudeSettings(
    deps,
    options,
    'hidden skill pointer hook',
    (settings) =>
      withHiddenSkillPointerRegistered(settings, hiddenSkillPointerHookCommand(options.throneRoot)),
  );
}
