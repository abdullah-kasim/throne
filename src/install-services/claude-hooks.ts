import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadRecallConfig } from '../relevance-classifier/recall-user-config.ts';
import { userConfigPath } from '../user-config-loader.ts';
import {
  isJsonObject,
  registerHookInClaudeSettings,
  withClaudeHookRegistered,
  withHookPlaced,
  type ClaudeHookEvent,
  type ClaudeSettingsHook,
  type JsonObject,
  type SettingsHookOutcome,
  type SettingsWithHookRegistered,
} from './claude-settings-hook.ts';
import type {
  InstallServicesDeps,
  InstallServicesOptions,
} from './install-services.types.ts';
import { THRONE_ROOT } from './service-unit-renderer.service.ts';

export type HookHarness = 'claude' | 'pi';

export interface HookListEntry {
  script: string;
  event: ClaudeHookEvent;
  matcher?: string;
  notOn?: HookHarness[];
  timeout?: number;
  statusMessage?: string;
  replaces?: string[];
  withGlobalMemoryDirectories?: boolean;
}

export interface ClaudeHookInstaller {
  name: string;
  install: (deps: InstallServicesDeps, options: InstallServicesOptions) => Promise<SettingsHookOutcome>;
}

export function hookListPath(throneRoot: string): string {
  return path.join(throneRoot, 'claude-hooks', 'hooks.json');
}

export function readHookList(throneRoot: string = THRONE_ROOT): HookListEntry[] {
  const listPath = hookListPath(throneRoot);
  try {
    return JSON.parse(readFileSync(listPath, 'utf8')) as HookListEntry[];
  } catch (error) {
    throw new Error(`${listPath} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function appliesToHarness(entry: HookListEntry, harness: HookHarness): boolean {
  return !(entry.notOn ?? []).includes(harness);
}

export function hookScriptCommand(
  throneRoot: string,
  script: string,
  scriptArguments: readonly string[] = [],
): string {
  return ['python3', path.join(throneRoot, 'claude-hooks', script), ...scriptArguments]
    .map((word, index) => (index === 0 ? word : JSON.stringify(word)))
    .join(' ');
}

async function configuredGlobalMemoryDirectories(throneRoot: string): Promise<readonly string[]> {
  try {
    return (await loadRecallConfig(userConfigPath(throneRoot))).globalMemoryDirectories;
  } catch {
    return [];
  }
}

function settingsHook(entry: HookListEntry): ClaudeSettingsHook {
  return {
    event: entry.event,
    matcher: entry.matcher,
    hookFileName: entry.script,
    timeout: entry.timeout,
    statusMessage: entry.statusMessage,
  };
}

function withReplacingHookRegistered(
  settings: JsonObject,
  entry: HookListEntry,
  command: string,
): SettingsWithHookRegistered {
  const oldScripts = (entry.replaces ?? []).map((pattern) => new RegExp(pattern));
  const isSameHook = (hook: unknown): boolean => {
    if (!isJsonObject(hook) || typeof hook.command !== 'string') return false;
    const existing = hook.command;
    return existing.includes(entry.script) || oldScripts.some((pattern) => pattern.test(existing));
  };
  return withHookPlaced(settings, settingsHook(entry), command, {
    isSameHook,
    entriesWithHookPlaced: (eventEntries, registeredHook) => {
      let placed = false;
      const nextEntries: unknown[] = [];
      for (const eventEntry of eventEntries) {
        if (!isJsonObject(eventEntry) || !Array.isArray(eventEntry.hooks)) {
          nextEntries.push(eventEntry);
          continue;
        }
        const keptHooks: unknown[] = [];
        for (const hook of eventEntry.hooks) {
          if (!isSameHook(hook)) {
            keptHooks.push(hook);
          } else if (!placed && eventEntry.matcher === entry.matcher) {
            keptHooks.push(registeredHook);
            placed = true;
          }
        }
        if (keptHooks.length > 0) nextEntries.push({ ...eventEntry, hooks: keptHooks });
      }
      return { nextEntries, placed };
    },
  });
}

export function withHookEntriesRegistered(
  settings: JsonObject,
  entries: readonly HookListEntry[],
  command: string,
): SettingsWithHookRegistered {
  return entries.reduce<SettingsWithHookRegistered>(
    (registered, entry) => {
      const next =
        entry.replaces === undefined
          ? withClaudeHookRegistered(registered.settings, settingsHook(entry), command)
          : withReplacingHookRegistered(registered.settings, entry, command);
      return {
        settings: next.settings,
        change: registered.change === 'unchanged' ? next.change : registered.change,
      };
    },
    { settings, change: 'unchanged' },
  );
}

function hookName(script: string): string {
  return script.replace(/\.py$/, '').replaceAll('-', ' ');
}

export function claudeHookInstallers(
  hookList: readonly HookListEntry[] = readHookList(),
): ClaudeHookInstaller[] {
  const claudeEntries = hookList.filter((entry) => appliesToHarness(entry, 'claude'));
  const scripts = [...new Set(claudeEntries.map((entry) => entry.script))];
  return scripts.map((script) => {
    const entries = claudeEntries.filter((entry) => entry.script === script);
    return {
      name: hookName(script),
      install: async (deps, options) => {
        const scriptArguments = entries.some((entry) => entry.withGlobalMemoryDirectories === true)
          ? await configuredGlobalMemoryDirectories(options.throneRoot)
          : [];
        const command = hookScriptCommand(options.throneRoot, script, scriptArguments);
        return registerHookInClaudeSettings(deps, options, `${hookName(script)} hook`, (settings) =>
          withHookEntriesRegistered(settings, entries, command),
        );
      },
    };
  });
}
