import path from 'node:path';
import {
  registerHookInClaudeSettings,
  withClaudeHookRegistered,
  type ClaudeSettingsHook,
  type JsonObject,
  type SettingsHookOutcome,
  type SettingsWithHookRegistered,
} from './claude-settings-hook.ts';
import type {
  InstallServicesDeps,
  InstallServicesOptions,
} from './install-services.types.ts';

const AGENT_EXIT_MARKER_HOOK_FILE_NAME = 'agent-exit-marker.py';

const AGENT_EXIT_MARKER_HOOKS: readonly ClaudeSettingsHook[] = [
  { event: 'SessionEnd', matcher: '*', hookFileName: AGENT_EXIT_MARKER_HOOK_FILE_NAME },
  { event: 'SessionStart', matcher: '*', hookFileName: AGENT_EXIT_MARKER_HOOK_FILE_NAME },
];

export function agentExitMarkerHookCommand(throneRoot: string): string {
  const hookPath = path.join(throneRoot, 'claude-hooks', AGENT_EXIT_MARKER_HOOK_FILE_NAME);
  return `python3 "${hookPath}"`;
}

export function withAgentExitMarkerRegistered(
  settings: JsonObject,
  command: string,
): SettingsWithHookRegistered {
  return AGENT_EXIT_MARKER_HOOKS.reduce<SettingsWithHookRegistered>(
    (registered, hook) => {
      const next = withClaudeHookRegistered(registered.settings, hook, command);
      return {
        settings: next.settings,
        change: registered.change === 'unchanged' ? next.change : registered.change,
      };
    },
    { settings, change: 'unchanged' },
  );
}

export async function installAgentExitMarkerHook(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<SettingsHookOutcome> {
  return registerHookInClaudeSettings(
    deps,
    options,
    'agent exit marker hook',
    (settings) =>
      withAgentExitMarkerRegistered(settings, agentExitMarkerHookCommand(options.throneRoot)),
  );
}
