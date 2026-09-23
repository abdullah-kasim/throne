import path from 'node:path';
import type {
  InstallServicesDeps,
  InstallServicesOptions,
} from './install-services.types.ts';
import {
  writeInstallServicesError,
  writeInstallServicesLine,
} from './output.ts';

export const GUARD_HOOK_FILE_NAME = 'scratch-path-guard.py';
export const RETIRED_GUARD_HOOK_FILE_NAME = 'rm-literal-home-guard.py';
const GUARD_HOOK_STATUS_MESSAGE = 'scratch path guard';
const GUARD_HOOK_TIMEOUT_SECONDS = 5;

export type GuardHookRegistrationChange =
  | 'unchanged'
  | 'registered'
  | 'replaced';

export type GuardHookOutcome = GuardHookRegistrationChange | 'error';

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function guardHookPath(throneRoot: string): string {
  return path.join(throneRoot, 'claude-hooks', GUARD_HOOK_FILE_NAME);
}

export function guardHookCommand(throneRoot: string): string {
  return `python3 "${guardHookPath(throneRoot)}"`;
}

function isGuardHook(hook: unknown): boolean {
  if (!isJsonObject(hook) || typeof hook.command !== 'string') return false;
  return (
    hook.command.includes(GUARD_HOOK_FILE_NAME) ||
    hook.command.includes(RETIRED_GUARD_HOOK_FILE_NAME)
  );
}

export function withGuardHookRegistered(
  settings: JsonObject,
  command: string,
): { settings: JsonObject; change: GuardHookRegistrationChange } {
  const hooks = isJsonObject(settings.hooks) ? settings.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const guardHook = {
    type: 'command',
    command,
    timeout: GUARD_HOOK_TIMEOUT_SECONDS,
    statusMessage: GUARD_HOOK_STATUS_MESSAGE,
  };

  let registeredCount = 0;
  let staleCount = 0;
  for (const entry of preToolUse) {
    if (!isJsonObject(entry) || !Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!isGuardHook(hook)) continue;
      if (isJsonObject(hook) && hook.command === command) registeredCount += 1;
      else staleCount += 1;
    }
  }
  if (registeredCount === 1 && staleCount === 0) {
    return { settings, change: 'unchanged' };
  }

  let placed = false;
  const nextPreToolUse: unknown[] = [];
  for (const entry of preToolUse) {
    if (!isJsonObject(entry) || !Array.isArray(entry.hooks)) {
      nextPreToolUse.push(entry);
      continue;
    }
    const keptHooks: unknown[] = [];
    for (const hook of entry.hooks) {
      if (!isGuardHook(hook)) {
        keptHooks.push(hook);
      } else if (!placed && entry.matcher === 'Bash') {
        keptHooks.push(guardHook);
        placed = true;
      }
    }
    if (keptHooks.length > 0) nextPreToolUse.push({ ...entry, hooks: keptHooks });
  }
  if (!placed) {
    nextPreToolUse.push({ matcher: 'Bash', hooks: [guardHook] });
  }
  return {
    settings: { ...settings, hooks: { ...hooks, PreToolUse: nextPreToolUse } },
    change: registeredCount + staleCount === 0 ? 'registered' : 'replaced',
  };
}

export async function installClaudeGuardHook(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<GuardHookOutcome> {
  const settingsPath = deps.claudeSettingsPath();
  const existingText = await deps.readClaudeSettings(settingsPath);
  let existing: unknown = {};
  if (existingText !== null && existingText.trim() !== '') {
    try {
      existing = JSON.parse(existingText);
    } catch (error) {
      writeInstallServicesError(
        `install-services: ${settingsPath} is not valid JSON, so the Claude guard hook was not registered: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return 'error';
    }
  }
  if (!isJsonObject(existing)) {
    writeInstallServicesError(
      `install-services: ${settingsPath} does not hold a JSON object, so the Claude guard hook was not registered\n`,
    );
    return 'error';
  }
  const { settings, change } = withGuardHookRegistered(
    existing,
    guardHookCommand(options.throneRoot),
  );
  if (change === 'unchanged') {
    writeInstallServicesLine(`claude guard hook: unchanged → ${settingsPath}`);
    return change;
  }
  if (options.dryRun) {
    writeInstallServicesLine(
      `would ${change === 'registered' ? 'register' : 'replace'} claude guard hook → ${settingsPath}`,
    );
    return change;
  }
  await deps.writeClaudeSettings(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
  );
  writeInstallServicesLine(`claude guard hook: ${change} → ${settingsPath}`);
  return change;
}
