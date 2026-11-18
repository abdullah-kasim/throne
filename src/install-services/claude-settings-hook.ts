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

export type ClaudeHookEvent = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'SessionStart' | 'SessionEnd' | 'UserPromptSubmit' | 'Stop';

export interface ClaudeSettingsHook {
  event: ClaudeHookEvent;
  matcher?: string;
  hookFileName: string;
  timeout?: number;
  statusMessage?: string;
}

export function commandHook(hook: ClaudeSettingsHook, command: string): JsonObject {
  return {
    type: 'command',
    command,
    ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
    ...(hook.statusMessage === undefined ? {} : { statusMessage: hook.statusMessage }),
  };
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHookRunningFile(hook: unknown, hookFileName: string): boolean {
  if (!isJsonObject(hook) || typeof hook.command !== 'string') return false;
  return hook.command.includes(hookFileName);
}

function isEntryForMatcher(
  entry: unknown,
  matcher: string | undefined,
): entry is JsonObject & { hooks: unknown[] } {
  return isJsonObject(entry) && entry.matcher === matcher && Array.isArray(entry.hooks);
}

export interface HookPlacement {
  isSameHook: (hook: unknown, entry: JsonObject) => boolean;
  entriesWithHookPlaced: (
    entries: readonly unknown[],
    registeredHook: JsonObject,
  ) => { nextEntries: unknown[]; placed: boolean };
}

export function withHookPlaced(
  settings: JsonObject,
  hook: ClaudeSettingsHook,
  command: string,
  placement: HookPlacement,
): SettingsWithHookRegistered {
  const hooks = isJsonObject(settings.hooks) ? settings.hooks : {};
  const eventEntries = hooks[hook.event];
  const entries = Array.isArray(eventEntries) ? eventEntries : [];

  let registeredCount = 0;
  let staleCount = 0;
  for (const entry of entries) {
    if (!isJsonObject(entry) || !Array.isArray(entry.hooks)) continue;
    for (const existingHook of entry.hooks) {
      if (!placement.isSameHook(existingHook, entry)) continue;
      if (isJsonObject(existingHook) && existingHook.command === command) registeredCount += 1;
      else staleCount += 1;
    }
  }
  if (registeredCount === 1 && staleCount === 0) {
    return { settings, change: 'unchanged' };
  }

  const registeredHook = commandHook(hook, command);
  const { nextEntries, placed } = placement.entriesWithHookPlaced(entries, registeredHook);
  if (!placed) {
    nextEntries.push(
      hook.matcher === undefined
        ? { hooks: [registeredHook] }
        : { matcher: hook.matcher, hooks: [registeredHook] },
    );
  }
  return {
    settings: { ...settings, hooks: { ...hooks, [hook.event]: nextEntries } },
    change: registeredCount + staleCount === 0 ? 'registered' : 'replaced',
  };
}

export function withClaudeHookRegistered(
  settings: JsonObject,
  hook: ClaudeSettingsHook,
  command: string,
): SettingsWithHookRegistered {
  return withHookPlaced(settings, hook, command, {
    isSameHook: (existingHook, entry) =>
      isEntryForMatcher(entry, hook.matcher) && isHookRunningFile(existingHook, hook.hookFileName),
    entriesWithHookPlaced: (entries, registeredHook) => {
      let placed = false;
      const nextEntries: unknown[] = [];
      for (const entry of entries) {
        if (!isEntryForMatcher(entry, hook.matcher)) {
          nextEntries.push(entry);
          continue;
        }
        const keptHooks: unknown[] = entry.hooks.filter(
          (existingHook) => !isHookRunningFile(existingHook, hook.hookFileName),
        );
        keptHooks.push(registeredHook);
        placed = true;
        nextEntries.push({ ...entry, hooks: keptHooks });
      }
      return { nextEntries, placed };
    },
  });
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
