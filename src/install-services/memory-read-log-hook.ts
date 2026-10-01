import path from 'node:path';
import { loadRecallConfig } from '../relevance-classifier/recall-user-config.ts';
import { userConfigPath } from '../user-config-loader.ts';
import {
  registerHookInClaudeSettings,
  withToolUseHookRegistered,
  type SettingsHookOutcome,
  type ToolUseHook,
} from './claude-settings-hook.ts';
import type {
  InstallServicesDeps,
  InstallServicesOptions,
} from './install-services.types.ts';

const MEMORY_READ_LOG_HOOK: ToolUseHook = {
  event: 'PostToolUse',
  matcher: 'Read|Grep|Glob|Bash',
  hookFileName: 'memory-read-log.py',
};

export function memoryReadLogHookCommand(
  throneRoot: string,
  globalMemoryDirectories: readonly string[],
): string {
  const hookPath = path.join(throneRoot, 'claude-hooks', MEMORY_READ_LOG_HOOK.hookFileName);
  return ['python3', hookPath, ...globalMemoryDirectories]
    .map((word, index) => (index === 0 ? word : JSON.stringify(word)))
    .join(' ');
}

async function configuredGlobalMemoryDirectories(
  throneRoot: string,
): Promise<readonly string[]> {
  try {
    return (await loadRecallConfig(userConfigPath(throneRoot))).globalMemoryDirectories;
  } catch {
    return [];
  }
}

export async function installMemoryReadLogHook(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<SettingsHookOutcome> {
  const command = memoryReadLogHookCommand(
    options.throneRoot,
    await configuredGlobalMemoryDirectories(options.throneRoot),
  );
  return registerHookInClaudeSettings(deps, options, 'memory read log hook', (settings) =>
    withToolUseHookRegistered(settings, MEMORY_READ_LOG_HOOK, command),
  );
}
