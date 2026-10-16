import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import type { SpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import { runNoIdling } from './no-idling-run.ts';
import { deps, rosterEntry } from './no-idling-command-test-fixtures.ts';

const PANE_SHOWING_QUEUED_SUITE_RUNS = await readFile(
  path.join(import.meta.dirname, 'fixtures', 'claude-pane-waiting-on-queued-suite-runs.txt'),
  'utf8',
);
const PANE_AT_ITS_IDENTITY_PROMPT = [
  '❯ You are shadow-bakery-01-oven (Shadow). Your supervisor is alpha-bakery-01.',
  '',
  '────────────────────────────────────────────────────────────────',
  '❯',
  '────────────────────────────────────────────────────────────────',
  '  Opus 5.5 · effort:medium · ~/.throne/worktrees/bakery/shado…',
  '',
].join('\n');
const PANE_THAT_ONLY_REPLIED_TO_ITS_IDENTITY_PROMPT = [
  '❯ You are shadow-bakery-01-oven (Shadow). Your supervisor is alpha-bakery-01.',
  '',
  '  Ran 1 shell command',
  '',
  '⏺ Memory read. Waiting for my assignment from alpha-bakery-01.',
  '',
  '✻ Baked for 9s',
  '',
  '────────────────────────────────────────────────────────────────',
  '❯',
  '────────────────────────────────────────────────────────────────',
  '  Opus 5.5 · effort:medium · ~/.throne/worktrees/bakery/shado…',
  '',
].join('\n');
const PANE_THAT_PUBLISHED_THE_BLOCKED_MARKER = [
  '⏺ Both suite runs are queued for a container slot.',
  '',
  '  {"blocked":true} BLOCKED_BY_own-background-run (candidate and base suites)',
  '',
  '✻ Crunched for 5s',
  '',
].join('\n');
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

async function untaskedNoticesForAShadowShowing(pane: () => Promise<string>): Promise<string[]> {
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [rosterEntry('shadow-bakery-01-oven', 'Shadow', 'idle')],
    readSpawnSpec: async () => SPAWNED_TWELVE_MINUTES_EARLIER_AND_NEVER_TASKED,
    readAgent: pane,
    now: () => NOW_MS,
  });
  await runNoIdling(dependencies, { notify: true });
  return submitCalls.map((call) => call.prompt).filter((prompt) => UNTASKED_NOTICE.test(prompt));
}

test('an agent that read its own assignment and is waiting on background work is not reported as untasked', async () => {
  assert.deepEqual(await untaskedNoticesForAShadowShowing(async () => PANE_SHOWING_QUEUED_SUITE_RUNS), []);
});

test('an agent that never spoke after its identity prompt is still reported as untasked', async () => {
  const notices = await untaskedNoticesForAShadowShowing(async () => PANE_AT_ITS_IDENTITY_PROMPT);

  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /shadow-bakery-01-oven \(Shadow\)/);
});

test('an agent that only replied to its identity prompt is still reported as untasked', async () => {
  const notices = await untaskedNoticesForAShadowShowing(async () => PANE_THAT_ONLY_REPLIED_TO_ITS_IDENTITY_PROMPT);

  assert.equal(notices.length, 1);
});

test('an agent whose latest message is the blocked marker is not reported as untasked', async () => {
  assert.deepEqual(await untaskedNoticesForAShadowShowing(async () => PANE_THAT_PUBLISHED_THE_BLOCKED_MARKER), []);
});

test('an agent whose pane cannot be read is still reported as untasked', async () => {
  const notices = await untaskedNoticesForAShadowShowing(async () => {
    throw new Error('pane is gone');
  });

  assert.equal(notices.length, 1);
});
