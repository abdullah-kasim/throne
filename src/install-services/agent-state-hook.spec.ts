import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentStateHookCommand, installAgentStateHook } from './agent-state-hook.ts';
import { REAL_DEPS } from './platform.ts';

test('installing registers the agent state hook at prompt start and at turn end', async () => {
  const written: string[] = [];
  await installAgentStateHook(
    {
      ...REAL_DEPS,
      claudeSettingsPath: () => '/srv/home/.claude/settings.json',
      readClaudeSettings: async () => null,
      writeClaudeSettings: async (_settingsPath, content) => {
        written.push(content);
      },
    },
    { dryRun: false, throneRoot: '/srv/throne', throneRootExplicit: true },
  );
  const hook = [{ type: 'command', command: agentStateHookCommand('/srv/throne') }];
  assert.deepEqual(JSON.parse(written[0]!).hooks, {
    UserPromptSubmit: [{ hooks: hook }],
    Stop: [{ hooks: hook }],
  });
});
