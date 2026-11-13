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

const WEB_FETCH_FAILURE_POINTER_HOOK_FILE_NAME = 'web-fetch-failure-pointer.py';

const WEB_FETCH_FAILURE_POINTER_HOOKS: readonly ClaudeSettingsHook[] = [
  { event: 'PostToolUse', matcher: 'WebFetch', hookFileName: WEB_FETCH_FAILURE_POINTER_HOOK_FILE_NAME },
  { event: 'PostToolUse', matcher: 'Bash', hookFileName: WEB_FETCH_FAILURE_POINTER_HOOK_FILE_NAME },
  { event: 'PostToolUseFailure', matcher: 'WebFetch', hookFileName: WEB_FETCH_FAILURE_POINTER_HOOK_FILE_NAME },
  { event: 'PostToolUseFailure', matcher: 'Bash', hookFileName: WEB_FETCH_FAILURE_POINTER_HOOK_FILE_NAME },
];

export function webFetchFailurePointerHookCommand(throneRoot: string): string {
  const hookPath = path.join(throneRoot, 'claude-hooks', WEB_FETCH_FAILURE_POINTER_HOOK_FILE_NAME);
  return `python3 "${hookPath}"`;
}

export function withWebFetchFailurePointerRegistered(
  settings: JsonObject,
  command: string,
): SettingsWithHookRegistered {
  return withClaudeHooksRegistered(settings, WEB_FETCH_FAILURE_POINTER_HOOKS, command);
}

export async function installWebFetchFailurePointerHook(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<SettingsHookOutcome> {
  return registerHookInClaudeSettings(
    deps,
    options,
    'web fetch failure pointer hook',
    (settings) =>
      withWebFetchFailurePointerRegistered(settings, webFetchFailurePointerHookCommand(options.throneRoot)),
  );
}
