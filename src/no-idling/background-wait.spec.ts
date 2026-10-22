import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  readHarnessBackgroundWork,
  type HarnessBackgroundWorkHost,
} from '../process-inspection/harness-background-work.ts';
import {
  harnessProcessHost,
  processTableCapture,
  PROCESS_HOST_WITHOUT_HERDR,
} from '../process-inspection/harness-background-work-test-fixtures.ts';
import { runNoIdling } from './no-idling-run.ts';
import { deps, identityFound, rosterEntry } from './no-idling-command-test-fixtures.ts';

const ALPHA = 'alpha-bakery-01';
const SHADOW = 'shadow-bakery-01-oven';
const WORKTREE = await realpath(await mkdtemp(path.join(tmpdir(), 'background-wait-')));
const HOLD_SCRIPT_HOST = harnessProcessHost({
  processTable: await processTableCapture('macos-claude-harness-with-background-hold-script'),
  harnessDirectory: WORKTREE,
});
const IDLE_HOST = harnessProcessHost({
  processTable: await processTableCapture('macos-claude-idle-harness'),
  harnessDirectory: WORKTREE,
});
const PANE_OF_AN_ALPHA_THAT_SAYS_NOTHING_ABOUT_ITS_RUN = ['⏺ The oven slice is merged.', '', '✻ Baked for 9s', ''].join('\n');
const PANE_OF_AN_IDLE_SHADOW = ['⏺ Done with the crust.', '', '✻ Baked for 4s', ''].join('\n');

async function idleFamilyNoticesWhenTheAlphaHarnessRunsOn(alphaHost: HarnessBackgroundWorkHost): Promise<string[]> {
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [rosterEntry(ALPHA, 'Alpha', 'idle'), rosterEntry(SHADOW, 'Shadow', 'idle')],
    readAgentSupervisor: async (name) => identityFound(name === SHADOW ? ALPHA : 'Regent'),
    readAgent: async (name) => (name === ALPHA ? PANE_OF_AN_ALPHA_THAT_SAYS_NOTHING_ABOUT_ITS_RUN : PANE_OF_AN_IDLE_SHADOW),
    readHarnessBackgroundWork: (paneId) =>
      readHarnessBackgroundWork(paneId, paneId === `pane-${ALPHA}` ? alphaHost : IDLE_HOST),
    isRegisteredAgent: async () => true,
  });
  await runNoIdling(dependencies, { notify: true });
  return submitCalls.map((call) => call.prompt).filter((prompt) => prompt.includes(ALPHA));
}

test('a family whose Alpha is waiting on a live background run is not reported idle', async () => {
  assert.deepEqual(await idleFamilyNoticesWhenTheAlphaHarnessRunsOn(HOLD_SCRIPT_HOST), []);
  assert.match((await idleFamilyNoticesWhenTheAlphaHarnessRunsOn(IDLE_HOST)).join('\n'), /fully-idle/);
});

test('an agent whose processes cannot be read is not reported as running work', async () => {
  const notices = await idleFamilyNoticesWhenTheAlphaHarnessRunsOn(PROCESS_HOST_WITHOUT_HERDR);

  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /fully-idle/);
});
