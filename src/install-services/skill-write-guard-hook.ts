import path from 'node:path';
import type {
  InstallServicesDeps,
  InstallServicesOptions,
} from './install-services.types.ts';
import {
  writeInstallServicesError,
  writeInstallServicesLine,
} from './output.ts';

export const SKILL_WRITE_GUARD_HOOK_FILE_NAME = 'skill-write-guard.py';
const SKILL_WRITE_GUARD_MATCHER = 'Edit|Write';

export type SkillWriteGuardRegistrationChange =
  | 'unchanged'
  | 'registered'
  | 'replaced';

export type SkillWriteGuardOutcome = SkillWriteGuardRegistrationChange | 'error';

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function skillWriteGuardHookPath(throneRoot: string): string {
  return path.join(throneRoot, 'claude-hooks', SKILL_WRITE_GUARD_HOOK_FILE_NAME);
}

export function skillWriteGuardHookCommand(throneRoot: string): string {
  return `python3 "${skillWriteGuardHookPath(throneRoot)}"`;
}

function isSkillWriteGuardHook(hook: unknown): boolean {
  if (!isJsonObject(hook) || typeof hook.command !== 'string') return false;
  return hook.command.includes(SKILL_WRITE_GUARD_HOOK_FILE_NAME);
}

export function withSkillWriteGuardRegistered(
  settings: JsonObject,
  command: string,
): { settings: JsonObject; change: SkillWriteGuardRegistrationChange } {
  const hooks = isJsonObject(settings.hooks) ? settings.hooks : {};
  const postToolUse = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  const skillWriteGuardHook = { type: 'command', command };

  let registeredCount = 0;
  let staleCount = 0;
  for (const entry of postToolUse) {
    if (
      !isJsonObject(entry) ||
      entry.matcher !== SKILL_WRITE_GUARD_MATCHER ||
      !Array.isArray(entry.hooks)
    ) {
      continue;
    }
    for (const hook of entry.hooks) {
      if (!isSkillWriteGuardHook(hook)) continue;
      if (isJsonObject(hook) && hook.command === command) registeredCount += 1;
      else staleCount += 1;
    }
  }
  if (registeredCount === 1 && staleCount === 0) {
    return { settings, change: 'unchanged' };
  }

  let placed = false;
  const nextPostToolUse: unknown[] = [];
  for (const entry of postToolUse) {
    if (
      !isJsonObject(entry) ||
      entry.matcher !== SKILL_WRITE_GUARD_MATCHER ||
      !Array.isArray(entry.hooks)
    ) {
      nextPostToolUse.push(entry);
      continue;
    }
    const keptHooks: unknown[] = entry.hooks.filter(
      (hook) => !isSkillWriteGuardHook(hook),
    );
    keptHooks.push(skillWriteGuardHook);
    placed = true;
    nextPostToolUse.push({ ...entry, hooks: keptHooks });
  }
  if (!placed) {
    nextPostToolUse.push({
      matcher: SKILL_WRITE_GUARD_MATCHER,
      hooks: [skillWriteGuardHook],
    });
  }
  return {
    settings: { ...settings, hooks: { ...hooks, PostToolUse: nextPostToolUse } },
    change: registeredCount + staleCount === 0 ? 'registered' : 'replaced',
  };
}

export async function installSkillWriteGuardHook(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<SkillWriteGuardOutcome> {
  const settingsPath = deps.claudeSettingsPath();
  const existingText = await deps.readClaudeSettings(settingsPath);
  let existing: unknown = {};
  if (existingText !== null && existingText.trim() !== '') {
    try {
      existing = JSON.parse(existingText);
    } catch (error) {
      writeInstallServicesError(
        `install-services: ${settingsPath} is not valid JSON, so the skill write guard hook was not registered: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return 'error';
    }
  }
  if (!isJsonObject(existing)) {
    writeInstallServicesError(
      `install-services: ${settingsPath} does not hold a JSON object, so the skill write guard hook was not registered\n`,
    );
    return 'error';
  }
  const { settings, change } = withSkillWriteGuardRegistered(
    existing,
    skillWriteGuardHookCommand(options.throneRoot),
  );
  if (change === 'unchanged') {
    writeInstallServicesLine(`skill write guard hook: unchanged → ${settingsPath}`);
    return change;
  }
  if (options.dryRun) {
    writeInstallServicesLine(
      `would ${change === 'registered' ? 'register' : 'replace'} skill write guard hook → ${settingsPath}`,
    );
    return change;
  }
  await deps.writeClaudeSettings(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
  );
  writeInstallServicesLine(`skill write guard hook: ${change} → ${settingsPath}`);
  return change;
}
