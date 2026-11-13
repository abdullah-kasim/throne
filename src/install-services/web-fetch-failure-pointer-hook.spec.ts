import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installWebFetchFailurePointerHook,
  webFetchFailurePointerHookCommand,
  withWebFetchFailurePointerRegistered,
} from './web-fetch-failure-pointer-hook.ts';
import { REAL_DEPS } from './platform.ts';
import type { InstallServicesDeps } from './install-services.types.ts';

const THRONE = '/srv/throne';
const COMMAND = webFetchFailurePointerHookCommand(THRONE);
const OPTIONS = { dryRun: false, throneRoot: THRONE, throneRootExplicit: true };

const SETTINGS_WITH_THE_OTHER_SIX_HOOKS = {
  model: 'opus',
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: 'python3 "/srv/throne/claude-hooks/scratch-path-guard.py"',
            timeout: 5,
            statusMessage: 'scratch path guard',
          },
        ],
      },
      { matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'python3 "/srv/throne/claude-hooks/skill-write-guard.py"' }] },
      { matcher: 'Skill', hooks: [{ type: 'command', command: 'python3 "/srv/throne/claude-hooks/hidden-skill-pointer.py"' }] },
    ],
    PostToolUse: [
      {
        matcher: 'Read',
        hooks: [
          { type: 'command', command: 'python3 "/srv/throne/claude-hooks/memory-read-log.py" "~/notes/agent-memory"' },
          { type: 'command', command: 'python3 "/srv/throne/claude-hooks/hidden-skill-pointer.py"' },
        ],
      },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/srv/throne/claude-hooks/jev-fence.py"' }] },
      { matcher: 'Skill', hooks: [{ type: 'command', command: 'python3 "/srv/throne/claude-hooks/hidden-skill-pointer.py"' }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'python3 "/srv/throne/claude-hooks/hidden-skill-pointer.py"' }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'python3 "/srv/throne/claude-hooks/agent-exit-marker.py"' }] }],
  },
};

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

function withoutThePointer(settings: unknown): unknown {
  return JSON.parse(JSON.stringify(settings), (key, value: unknown) => {
    if (key === 'PostToolUseFailure') return undefined;
    if (!Array.isArray(value)) return value;
    return value
      .filter((item) => !(typeof item === 'object' && item !== null && 'command' in item && item.command === COMMAND))
      .filter((item) => !(typeof item === 'object' && item !== null && 'hooks' in item && Array.isArray(item.hooks) && item.hooks.length === 0));
  });
}

test('installing registers the pointer after WebFetch and Bash calls, on success and on failure', () => {
  const { settings, change } = withWebFetchFailurePointerRegistered({ model: 'opus' }, COMMAND);
  const pointer = [{ type: 'command', command: COMMAND }];
  assert.equal(change, 'registered');
  assert.equal(COMMAND, 'python3 "/srv/throne/claude-hooks/web-fetch-failure-pointer.py"');
  assert.deepEqual(settings, {
    model: 'opus',
    hooks: {
      PostToolUse: [
        { matcher: 'WebFetch', hooks: pointer },
        { matcher: 'Bash', hooks: pointer },
      ],
      PostToolUseFailure: [
        { matcher: 'WebFetch', hooks: pointer },
        { matcher: 'Bash', hooks: pointer },
      ],
    },
  });
});

test('installing beside the other six hooks leaves every one of their registrations byte for byte unchanged', async () => {
  const before = JSON.stringify(SETTINGS_WITH_THE_OTHER_SIX_HOOKS, null, 2);
  const deps = depsWithSettings(before);
  assert.equal(await installWebFetchFailurePointerHook(deps, OPTIONS), 'registered');
  const after = JSON.parse(deps.written[0]) as unknown;
  assert.equal(JSON.stringify(withoutThePointer(after), null, 2), before);
});

test('installing twice leaves the settings unchanged', async () => {
  const deps = depsWithSettings(JSON.stringify(SETTINGS_WITH_THE_OTHER_SIX_HOOKS));
  assert.equal(await installWebFetchFailurePointerHook(deps, OPTIONS), 'registered');
  const rerun = depsWithSettings(deps.written[0]);
  assert.equal(await installWebFetchFailurePointerHook(rerun, OPTIONS), 'unchanged');
  assert.deepEqual(rerun.written, []);
});

test('a pointer registered from another checkout is replaced, not duplicated', () => {
  const stale = withWebFetchFailurePointerRegistered({}, webFetchFailurePointerHookCommand('/old/throne')).settings;
  const { settings, change } = withWebFetchFailurePointerRegistered(stale, COMMAND);
  assert.equal(change, 'replaced');
  assert.deepEqual(settings, withWebFetchFailurePointerRegistered({}, COMMAND).settings);
});
