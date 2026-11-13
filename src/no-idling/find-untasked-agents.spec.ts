import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { SpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import {
  readHarnessBackgroundWork,
  type HarnessBackgroundWorkHost,
} from '../process-inspection/harness-background-work.ts';
import { harnessProcessHost, processTableCapture } from '../process-inspection/harness-background-work-test-fixtures.ts';
import { runNoIdling } from './no-idling-run.ts';
import type { AgentState } from '../agentdata/agent-state.service.ts';
import { declaredState, deps, rosterEntry } from './no-idling-command-test-fixtures.ts';

const WORKTREE = await realpath(await mkdtemp(path.join(tmpdir(), 'find-untasked-agents-')));
const HOLD_SCRIPT_HOST = harnessProcessHost({
  processTable: await processTableCapture('macos-claude-harness-with-background-hold-script'),
  harnessDirectory: WORKTREE,
});
const NOW_MS = Date.parse('2026-10-15T08:40:00.000Z');
const SPAWNED_TWELVE_MINUTES_EARLIER_AND_NEVER_TASKED: SpawnSpec = {
  harness: 'claude',
  model: 'opus',
  effort: 2,
  cwd: '/throne/shadow-bakery-01-oven',
  spawned_at: '2026-10-15T08:28:00.000Z',
  spawn_finished_at: '2026-10-15T08:29:00.000Z',
  tasked_at: null,
};
const UNTASKED_NOTICE = /spawned but never tasked/;

async function untaskedNoticesForAShadowDeclaring(
  readState: () => Promise<AgentState>,
  processHost?: HarnessBackgroundWorkHost,
): Promise<string[]> {
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [rosterEntry('shadow-bakery-01-oven', 'Shadow', 'idle')],
    readSpawnSpec: async () => SPAWNED_TWELVE_MINUTES_EARLIER_AND_NEVER_TASKED,
    readAgentState: readState,
    ...(processHost === undefined ? {} : { readHarnessBackgroundWork: (paneId) => readHarnessBackgroundWork(paneId, processHost) }),
    now: () => NOW_MS,
  });
  await runNoIdling(dependencies, { notify: true });
  return submitCalls.map((call) => call.prompt).filter((prompt) => UNTASKED_NOTICE.test(prompt));
}

const WORKING = async (): Promise<AgentState> => declaredState('working', { declaredBy: 'turn-start' });

test('an agent whose harness is running tool work counts as having acted', async () => {
  assert.deepEqual(await untaskedNoticesForAShadowDeclaring(WORKING, HOLD_SCRIPT_HOST), []);
});

test('an agent whose state file says working is still reported as untasked', async () => {
  const notices = await untaskedNoticesForAShadowDeclaring(WORKING);

  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /shadow-bakery-01-oven \(Shadow\)/);
});

test('an agent whose state file says blocked or waiting is not reported as untasked', async () => {
  for (const state of ['blocked', 'waiting-on-own-run', 'waiting-on-supervisor', 'reapable'] as const) {
    assert.deepEqual(await untaskedNoticesForAShadowDeclaring(async () => declaredState(state)), [], state);
  }
});

test('an agent whose state file cannot be read is still reported as untasked', async () => {
  const notices = await untaskedNoticesForAShadowDeclaring(async () => {
    throw new Error('state file is gone');
  });

  assert.equal(notices.length, 1);
});
