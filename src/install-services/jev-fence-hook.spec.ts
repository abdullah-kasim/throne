import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeScratchDirectory } from '../scratch-directory.test-support.ts';
import { installJevFenceHook, jevFenceHookCommand } from './jev-fence-hook.ts';
import { REAL_DEPS } from './platform.ts';
import type { InstallServicesDeps } from './install-services.types.ts';

const THRONE = '/srv/throne';
const OPTIONS = { dryRun: false, throneRoot: THRONE, throneRootExplicit: true };
async function settingsFile(initial: string | null): Promise<{ settingsPath: string; deps: InstallServicesDeps }> {
  const directory = await makeScratchDirectory('jev-fence-hook-');
  const settingsPath = path.join(directory, '.claude', 'settings.json');
  if (initial !== null) {
    await REAL_DEPS.writeClaudeSettings(settingsPath, initial);
  }
  return { settingsPath, deps: { ...REAL_DEPS, claudeSettingsPath: () => settingsPath } };
}

async function preToolUseEntries(settingsPath: string): Promise<{ matcher: string; hooks: { command: string }[] }[]> {
  const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
  };
  return settings.hooks.PreToolUse;
}

test('the Jev fence is registered as a PreToolUse hook on every tool that can reach Jev', async () => {
  const { settingsPath, deps } = await settingsFile(null);

  assert.equal(await installJevFenceHook(deps, OPTIONS), 'registered');

  assert.deepEqual(await preToolUseEntries(settingsPath), [
    {
      matcher: 'Bash|Read|Grep|Write|Edit|MultiEdit',
      hooks: [{ type: 'command', command: 'python3 "/srv/throne/claude-hooks/jev-fence.py"' }],
    },
  ]);
  assert.equal(await installJevFenceHook(deps, OPTIONS), 'unchanged');
});

test('registering the Jev fence keeps every other hook and replaces a stale fence path', async () => {
  const scratchGuard = { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 scratch-path-guard.py' }] };
  const staleFence = {
    matcher: 'Bash|Read|Grep|Write|Edit|MultiEdit',
    hooks: [{ type: 'command', command: jevFenceHookCommand('/old/throne') }],
  };
  const { settingsPath, deps } = await settingsFile(
    JSON.stringify({ model: 'opus', hooks: { PreToolUse: [scratchGuard, staleFence], Stop: [] } }),
  );

  assert.equal(await installJevFenceHook(deps, OPTIONS), 'replaced');

  const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { model: string; hooks: { Stop: unknown } };
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.hooks.Stop, []);
  assert.deepEqual(
    (await preToolUseEntries(settingsPath)).map((entry) => entry.hooks.map((hook) => hook.command)),
    [['python3 scratch-path-guard.py'], [jevFenceHookCommand(THRONE)]],
  );
});

test('unreadable settings are left untouched and the Jev fence reports an error', async () => {
  const { settingsPath, deps } = await settingsFile('{ not json');

  assert.equal(await installJevFenceHook(deps, OPTIONS), 'error');

  assert.equal(await readFile(settingsPath, 'utf8'), '{ not json');
});

test('a dry run names the Jev fence change without writing the settings', async () => {
  const { settingsPath, deps } = await settingsFile('{}');

  assert.equal(await installJevFenceHook(deps, { ...OPTIONS, dryRun: true }), 'registered');

  assert.equal(await readFile(settingsPath, 'utf8'), '{}');
});
