import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { reconcileBlockedAgentPages } from './blocked-agent-paging.hosted-worker.ts';
import { fakeBlockedAgentPagingDependencies } from './blocked-agent-paging-test-fixtures.ts';
import { resolveThroneHome } from '../shared-policy/throne-home.ts';

const CAPTURED_FOLDER = '/var/tmp/trustcapture-herdr-12345';
const FOLDER_TRUST_PANE = await readFile(
  path.join(import.meta.dirname, '..', 'pane-prompts', 'fixtures', 'claude-folder-trust-prompt.txt'),
  'utf8',
);
const SHADOW = 'shadow-bakery-01-oven';
const THRONE_HOME = resolveThroneHome(process.env, homedir());
const CAMPAIGN_WORKTREES_ROOT = path.join(await realpath(THRONE_HOME).catch(() => THRONE_HOME), 'worktrees');
const SHADOW_PANE = 'w1:p3';

function shadowAtFolderTrustPromptFor(folder: string) {
  return fakeBlockedAgentPagingDependencies({
    now: Date.parse('2026-11-11T09:00:00.000Z'),
    roster: [
      { name: 'regent', lifecycle: 'live', liveStatus: 'working', reportLanded: false, focused: false, paneId: 'w1:p1' },
      { name: SHADOW, lifecycle: 'live', liveStatus: 'blocked', reportLanded: false, role: 'Shadow', focused: false, paneId: SHADOW_PANE },
    ],
    supervisorOf: () => 'regent',
    visiblePaneText: (paneId) => (paneId === SHADOW_PANE ? FOLDER_TRUST_PANE.replaceAll(CAPTURED_FOLDER, folder) : ''),
  });
}

test('the court accepts the folder-trust prompt for its own campaign worktree without paging', async () => {
  const court = shadowAtFolderTrustPromptFor(path.join(CAMPAIGN_WORKTREES_ROOT, 'bakery', SHADOW));
  await reconcileBlockedAgentPages(court.dependencies);
  assert.deepEqual(court.folderTrustAcceptances, [{ agentName: SHADOW, optionNumber: 2 }]);
  assert.deepEqual(court.pages, []);
});

test('a folder-trust prompt for a folder outside the campaign worktree root pages the Regent with the mcq command', async () => {
  const court = shadowAtFolderTrustPromptFor(CAPTURED_FOLDER);
  await reconcileBlockedAgentPages(court.dependencies);
  assert.deepEqual(court.folderTrustAcceptances, []);
  assert.equal(court.pages.length, 1);
  assert.match(court.pages[0]!, /Prompt \(claude folder-trust\)/u);
  assert.ok(court.pages[0]!.includes(`Folder: ${CAPTURED_FOLDER}`));
  assert.ok(court.pages[0]!.includes(`throne mcq --agent ${SHADOW} --answer <n>`));
  assert.ok(court.pages[0]!.includes('2. Yes, I trust this folder'));
});

test('a folder-trust prompt naming a folder that only starts with the campaign worktree root text is not accepted', async () => {
  const court = shadowAtFolderTrustPromptFor(`${CAMPAIGN_WORKTREES_ROOT}-elsewhere/project`);
  await reconcileBlockedAgentPages(court.dependencies);
  assert.deepEqual(court.folderTrustAcceptances, []);
  assert.equal(court.pages.length, 1);
});
