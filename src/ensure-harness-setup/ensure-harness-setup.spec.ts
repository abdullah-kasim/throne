import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeScratchDirectory } from '../scratch-directory.test-support.ts';
import { ensureHarnessHooks } from './ensure-harness-setup.ts';
import { REAL_DEPS } from '../install-services/platform.ts';
import type { InstallServicesDeps } from '../install-services/install-services.types.ts';

test('ensure-harness-setup registers the Jev fence for every Claude Code session', async () => {
  const scratch = await makeScratchDirectory('ensure-jev-fence-');
  const throneRoot = path.join(scratch, 'throne');
  const settingsPath = path.join(scratch, 'home', '.claude', 'settings.json');
  const installDeps: InstallServicesDeps = {
    ...REAL_DEPS,
    claudeSettingsPath: () => settingsPath,
  };

  const results = await ensureHarnessHooks(throneRoot, installDeps);

  assert.deepEqual(
    results.find((result) => result.hook === 'claude jev fence'),
    { hook: 'claude jev fence', state: 'added' },
  );
  const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
  };
  const fenceEntry = settings.hooks.PreToolUse.find((entry) =>
    entry.hooks.some((hook) => hook.command === `python3 "${path.join(throneRoot, 'claude-hooks', 'jev-fence.py')}"`),
  );
  assert.equal(fenceEntry?.matcher, 'Bash|Read|Grep|Write|Edit|MultiEdit');

  const rerun = await ensureHarnessHooks(throneRoot, installDeps);
  assert.deepEqual(
    rerun.find((result) => result.hook === 'claude jev fence'),
    { hook: 'claude jev fence', state: 'unchanged' },
  );
});
