import type {
  InstallServicesDeps,
  InstallServicesOptions,
} from './install-services.types.ts';
import {
  writeInstallServicesError,
  writeInstallServicesLine,
} from './output.ts';

export type SettingsHookRegistrationChange =
  | 'unchanged'
  | 'registered'
  | 'replaced';

export type SettingsHookOutcome = SettingsHookRegistrationChange | 'error';

export type JsonObject = Record<string, unknown>;

export interface SettingsWithHookRegistered {
  settings: JsonObject;
  change: SettingsHookRegistrationChange;
}

export type ToolUseHookEvent = 'PreToolUse' | 'PostToolUse';

export interface ToolUseHook {
  event: ToolUseHookEvent;
  matcher: string;
  hookFileName: string;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHookRunningFile(hook: unknown, hookFileName: string): boolean {
  if (!isJsonObject(hook) || typeof hook.command !== 'string') return false;
  return hook.command.includes(hookFileName);
}

function isEntryForMatcher(entry: unknown, matcher: string): entry is JsonObject & { hooks: unknown[] } {
  return isJsonObject(entry) && entry.matcher === matcher && Array.isArray(entry.hooks);
}

export function withToolUseHookRegistered(
  settings: JsonObject,
  hook: ToolUseHook,
  command: string,
): SettingsWithHookRegistered {
  const hooks = isJsonObject(settings.hooks) ? settings.hooks : {};
  const eventEntries = hooks[hook.event];
  const toolUse = Array.isArray(eventEntries) ? eventEntries : [];
  const commandHook = { type: 'command', command };

  let registeredCount = 0;
  let staleCount = 0;
  for (const entry of toolUse) {
    if (!isEntryForMatcher(entry, hook.matcher)) continue;
    for (const existingHook of entry.hooks) {
      if (!isHookRunningFile(existingHook, hook.hookFileName)) continue;
      if (isJsonObject(existingHook) && existingHook.command === command) registeredCount += 1;
      else staleCount += 1;
    }
  }
  if (registeredCount === 1 && staleCount === 0) {
    return { settings, change: 'unchanged' };
  }

  let placed = false;
  const nextToolUse: unknown[] = [];
  for (const entry of toolUse) {
    if (!isEntryForMatcher(entry, hook.matcher)) {
      nextToolUse.push(entry);
      continue;
    }
    const keptHooks: unknown[] = entry.hooks.filter(
      (existingHook) => !isHookRunningFile(existingHook, hook.hookFileName),
    );
    keptHooks.push(commandHook);
    placed = true;
    nextToolUse.push({ ...entry, hooks: keptHooks });
  }
  if (!placed) {
    nextToolUse.push({ matcher: hook.matcher, hooks: [commandHook] });
  }
  return {
    settings: { ...settings, hooks: { ...hooks, [hook.event]: nextToolUse } },
    change: registeredCount + staleCount === 0 ? 'registered' : 'replaced',
  };
}

export async function registerHookInClaudeSettings(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
  hookName: string,
  withHookRegistered: (settings: JsonObject) => SettingsWithHookRegistered,
): Promise<SettingsHookOutcome> {
  const settingsPath = deps.claudeSettingsPath();
  const existingText = await deps.readClaudeSettings(settingsPath);
  let existing: unknown = {};
  if (existingText !== null && existingText.trim() !== '') {
    try {
      existing = JSON.parse(existingText);
    } catch (error) {
      writeInstallServicesError(
        `install-services: ${settingsPath} is not valid JSON, so the ${hookName} was not registered: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return 'error';
    }
  }
  if (!isJsonObject(existing)) {
    writeInstallServicesError(
      `install-services: ${settingsPath} does not hold a JSON object, so the ${hookName} was not registered\n`,
    );
    return 'error';
  }
  const { settings, change } = withHookRegistered(existing);
  if (change === 'unchanged') {
    writeInstallServicesLine(`${hookName}: unchanged → ${settingsPath}`);
    return change;
  }
  if (options.dryRun) {
    writeInstallServicesLine(
      `would ${change === 'registered' ? 'register' : 'replace'} ${hookName} → ${settingsPath}`,
    );
    return change;
  }
  await deps.writeClaudeSettings(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
  );
  writeInstallServicesLine(`${hookName}: ${change} → ${settingsPath}`);
  return change;
}
