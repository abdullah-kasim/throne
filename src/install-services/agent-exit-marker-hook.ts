import path from 'node:path';
import {
  registerHookInClaudeSettings,
  withClaudeHooksRegistered,
  type ClaudeSettingsHook,
  type SettingsHookOutcome,
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

export async function installAgentExitMarkerHook(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<SettingsHookOutcome> {
  return registerHookInClaudeSettings(
    deps,
    options,
    'agent exit marker hook',
    (settings) =>
      withClaudeHooksRegistered(settings, AGENT_EXIT_MARKER_HOOKS, agentExitMarkerHookCommand(options.throneRoot)),
  );
}
