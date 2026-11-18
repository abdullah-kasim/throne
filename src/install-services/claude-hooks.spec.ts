import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  appliesToHarness,
  claudeHookInstallers,
  readHookList,
  type HookListEntry,
} from './claude-hooks.ts';
import { REAL_DEPS } from './platform.ts';
import type { InstallServicesDeps } from './install-services.types.ts';

const OPTIONS = { dryRun: false, throneRoot: '/srv/throne', throneRootExplicit: true };

function fixture(name: string): Promise<string> {
  return readFile(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
}

function settingsFile(initial: string | null): InstallServicesDeps & { current: () => string | null; writes: () => number } {
  let text = initial;
  let writeCount = 0;
  return {
    ...REAL_DEPS,
    claudeSettingsPath: () => '/srv/home/.claude/settings.json',
    readClaudeSettings: async () => text,
    writeClaudeSettings: async (_settingsPath, content) => {
      text = content;
      writeCount += 1;
    },
    current: () => text,
    writes: () => writeCount,
  };
}

async function installAll(deps: InstallServicesDeps, hookList?: HookListEntry[]): Promise<string[]> {
  const outcomes: string[] = [];
  for (const installer of claudeHookInstallers(hookList)) outcomes.push(await installer.install(deps, OPTIONS));
  return outcomes;
}

test('installing on empty settings writes exactly the entries the separate installers used to write', async () => {
  const deps = settingsFile(null);
  await installAll(deps);
  assert.equal(deps.current(), await fixture('installed-on-empty-settings.json'));
});

test('installing over old checkouts and retired guard scripts replaces them as the separate installers did', async () => {
  const deps = settingsFile(await fixture('stale-settings.json'));
  await installAll(deps);
  assert.equal(deps.current(), await fixture('installed-over-stale-settings.json'));
});

test('installing the hooks on a machine that already has them changes nothing in settings.json', async () => {
  const installed = await fixture('installed-on-empty-settings.json');
  const deps = settingsFile(installed);
  const outcomes = await installAll(deps);
  assert.deepEqual(new Set(outcomes), new Set(['unchanged']));
  assert.equal(deps.writes(), 0);
});

test('a hook added to the list is registered in Claude settings', async () => {
  const deps = settingsFile(null);
  await installAll(deps, [...readHookList(), { script: 'new-hook.py', event: 'PreToolUse', matcher: 'Bash' }]);
  const settings = JSON.parse(deps.current()!) as { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } };
  assert.deepEqual(
    settings.hooks.PreToolUse.flatMap((entry) =>
      entry.hooks.filter((hook) => hook.command.includes('new-hook.py')).map((hook) => [entry.matcher, hook]),
    ),
    [['Bash', { type: 'command', command: 'python3 "/srv/throne/claude-hooks/new-hook.py"' }]],
  );
});

test('a hook marked not on claude is left out of Claude settings', async () => {
  const deps = settingsFile(null);
  await installAll(deps, [{ script: 'pi-only.py', event: 'PreToolUse', matcher: 'Bash', notOn: ['claude'] }]);
  assert.equal(deps.current(), null);
});

test('agent state, hidden skill pointer and exit marker are the hooks kept off pi', () => {
  const offPi = readHookList().filter((entry) => !appliesToHarness(entry, 'pi')).map((entry) => entry.script);
  assert.deepEqual([...new Set(offPi)], ['agent-exit-marker.py', 'agent-state.py', 'hidden-skill-pointer.py']);
});

test('a hook another tool registered on the same matcher is kept beside the new one', async () => {
  const otherHook = { type: 'command', command: 'python3 comment-guard.py' };
  const deps = settingsFile(JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [otherHook] }], Stop: [{ hooks: [] }] } }));
  await installAll(deps, [{ script: 'skill-write-guard.py', event: 'PostToolUse', matcher: 'Edit|Write' }]);
  const settings = JSON.parse(deps.current()!) as { hooks: { PostToolUse: { hooks: { command: string }[] }[]; Stop: unknown } };
  assert.deepEqual(
    settings.hooks.PostToolUse.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
    ['python3 comment-guard.py', 'python3 "/srv/throne/claude-hooks/skill-write-guard.py"'],
  );
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [] }]);
});

test('a dry run reports the change without writing', async () => {
  const deps = settingsFile('{}');
  const [installer] = claudeHookInstallers([{ script: 'skill-write-guard.py', event: 'PostToolUse', matcher: 'Edit|Write' }]);
  assert.equal(await installer.install(deps, { ...OPTIONS, dryRun: true }), 'registered');
  assert.equal(deps.writes(), 0);
});

test('unreadable settings are left untouched and reported as an error', async () => {
  for (const text of ['{ not json', '[]']) {
    const deps = settingsFile(text);
    const [installer] = claudeHookInstallers([{ script: 'skill-write-guard.py', event: 'PostToolUse', matcher: 'Edit|Write' }]);
    assert.equal(await installer.install(deps, OPTIONS), 'error');
    assert.equal(deps.writes(), 0);
  }
});
