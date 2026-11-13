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

const AGENT_STATE_HOOK_FILE_NAME = 'agent-state.py';

const AGENT_STATE_HOOKS: readonly ClaudeSettingsHook[] = [
  { event: 'UserPromptSubmit', hookFileName: AGENT_STATE_HOOK_FILE_NAME },
  { event: 'Stop', hookFileName: AGENT_STATE_HOOK_FILE_NAME },
];

export function agentStateHookCommand(throneRoot: string): string {
  const hookPath = path.join(throneRoot, 'claude-hooks', AGENT_STATE_HOOK_FILE_NAME);
  return `python3 "${hookPath}"`;
}

export async function installAgentStateHook(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<SettingsHookOutcome> {
  return registerHookInClaudeSettings(
    deps,
    options,
    'agent state hook',
    (settings) =>
      withClaudeHooksRegistered(settings, AGENT_STATE_HOOKS, agentStateHookCommand(options.throneRoot)),
  );
}
