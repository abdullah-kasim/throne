import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeScratchDirectory } from '../scratch-directory.test-support.ts';
import { ensureHarnessHooks } from './ensure-harness-setup.ts';
import { REAL_DEPS } from '../install-services/platform.ts';
import type { InstallServicesDeps } from '../install-services/install-services.types.ts';

test('installing services never registers the retired relevance fence hook', async () => {
  const scratch = await makeScratchDirectory('ensure-retired-hook-');
  const throneRoot = path.join(scratch, 'throne');
  const settingsPath = path.join(scratch, 'home', '.claude', 'settings.json');
  const installDeps: InstallServicesDeps = {
    ...REAL_DEPS,
    claudeSettingsPath: () => settingsPath,
  };

  const results = await ensureHarnessHooks(throneRoot, installDeps);

  assert.equal(results.some((result) => result.hook.includes('fence')), false);
  assert.doesNotMatch(await readFile(settingsPath, 'utf8'), /-fence\.py/);
});

test('the installer registers the session end hook once and leaves it alone on a second run', async () => {
  const scratch = await makeScratchDirectory('ensure-agent-exit-marker-');
  const throneRoot = path.join(scratch, 'throne');
  const settingsPath = path.join(scratch, 'home', '.claude', 'settings.json');
  const installDeps: InstallServicesDeps = {
    ...REAL_DEPS,
    claudeSettingsPath: () => settingsPath,
  };
  const markerCommand = `python3 "${path.join(throneRoot, 'claude-hooks', 'agent-exit-marker.py')}"`;
  const markerCommandsOf = async (event: 'SessionEnd' | 'SessionStart') => {
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks: Record<string, { matcher: string; hooks: { command: string }[] }[]>;
    };
    return settings.hooks[event]!.flatMap((entry) =>
      entry.hooks
        .filter((hook) => hook.command === markerCommand)
        .map((hook) => [entry.matcher, hook.command]),
    );
  };

  const results = await ensureHarnessHooks(throneRoot, installDeps);
  const rerun = await ensureHarnessHooks(throneRoot, installDeps);

  assert.deepEqual(
    [results, rerun].map((run) => run.find((result) => result.hook === 'claude agent exit marker')),
    [
      { hook: 'claude agent exit marker', state: 'added' },
      { hook: 'claude agent exit marker', state: 'unchanged' },
    ],
  );
  assert.deepEqual(await markerCommandsOf('SessionEnd'), [['*', markerCommand]]);
  assert.deepEqual(await markerCommandsOf('SessionStart'), [['*', markerCommand]]);
});
