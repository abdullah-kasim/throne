import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hiddenSkillPointerHookCommand,
  installHiddenSkillPointerHook,
  withHiddenSkillPointerRegistered,
} from './hidden-skill-pointer-hook.ts';
import { REAL_DEPS } from './platform.ts';
import type { InstallServicesDeps } from './install-services.types.ts';

const THRONE = '/srv/throne';
const COMMAND = hiddenSkillPointerHookCommand(THRONE);
const OPTIONS = { dryRun: false, throneRoot: THRONE, throneRootExplicit: true };

function depsWithSettings(initial: string | null): InstallServicesDeps & { written: string[] } {
  const written: string[] = [];
  return {
    ...REAL_DEPS,
    written,
    claudeSettingsPath: () => '/srv/home/.claude/settings.json',
    readClaudeSettings: async () => initial,
    writeClaudeSettings: async (_settingsPath, content) => {
      written.push(content);
    },
  };
}

test('installing registers the hidden skill pointer for prompts, Skill calls and file reads', () => {
  const { settings, change } = withHiddenSkillPointerRegistered({ model: 'opus' }, COMMAND);
  const pointer = [{ type: 'command', command: COMMAND }];
  assert.equal(change, 'registered');
  assert.equal(COMMAND, 'python3 "/srv/throne/claude-hooks/hidden-skill-pointer.py"');
  assert.deepEqual(settings, {
    model: 'opus',
    hooks: {
      UserPromptSubmit: [{ hooks: pointer }],
      PreToolUse: [{ matcher: 'Skill', hooks: pointer }],
      PostToolUse: [
        { matcher: 'Skill', hooks: pointer },
        { matcher: 'Read', hooks: pointer },
      ],
    },
  });
});

test('installing twice leaves the settings unchanged', async () => {
  const deps = depsWithSettings(null);
  assert.equal(await installHiddenSkillPointerHook(deps, OPTIONS), 'registered');
  const rerun = depsWithSettings(deps.written[0]);
  assert.equal(await installHiddenSkillPointerHook(rerun, OPTIONS), 'unchanged');
  assert.deepEqual(rerun.written, []);
});

test('a pointer registered from another checkout is replaced, not duplicated', () => {
  const stale = withHiddenSkillPointerRegistered({}, hiddenSkillPointerHookCommand('/old/throne')).settings;
  const { settings, change } = withHiddenSkillPointerRegistered(stale, COMMAND);
  assert.equal(change, 'replaced');
  assert.deepEqual(settings, withHiddenSkillPointerRegistered({}, COMMAND).settings);
});

test('hooks already registered beside it are kept', () => {
  const prompt = { type: 'command', command: 'python3 prompt-log.py' };
  const reads = { type: 'command', command: 'python3 read-log.py' };
  const { settings } = withHiddenSkillPointerRegistered(
    {
      hooks: {
        UserPromptSubmit: [{ hooks: [prompt] }],
        PostToolUse: [{ matcher: 'Read', hooks: [reads] }],
      },
    },
    COMMAND,
  );
  const pointer = { type: 'command', command: COMMAND };
  const hooks = settings.hooks as Record<string, unknown>;
  assert.deepEqual(hooks.UserPromptSubmit, [{ hooks: [prompt, pointer] }]);
  assert.deepEqual(hooks.PostToolUse, [
    { matcher: 'Read', hooks: [reads, pointer] },
    { matcher: 'Skill', hooks: [pointer] },
  ]);
});
