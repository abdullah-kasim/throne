import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reconcileBlockedAgentPages } from './blocked-agent-paging.hosted-worker.ts';
import { fakeBlockedAgentPagingDependencies, type DeclaredState } from './blocked-agent-paging-test-fixtures.ts';
import { DELAY_BEFORE_TELLING_THE_REGENT_MS } from '../no-idling/dependency-cleared-wake.ts';

const NOW = Date.parse('2026-09-28T08:00:00.000Z');
const ALPHA = 'alpha-bakery-01';

function scenario(alphaState: DeclaredState) {
  return fakeBlockedAgentPagingDependencies({
    now: NOW,
    roster: [
      { name: 'regent', lifecycle: 'live', liveStatus: 'working', reportLanded: false, focused: false, paneId: 'w1:p1' },
      { name: ALPHA, lifecycle: 'live', liveStatus: 'done', reportLanded: false, role: 'Alpha', focused: false, paneId: 'w1:p2', cwd: '/worktrees/alpha-bakery-01' },
      { name: 'shadow-bakery-02-photos', lifecycle: 'live', liveStatus: 'working', reportLanded: false, role: 'Shadow', focused: false, paneId: 'w1:p3' },
    ],
    supervisorOf: (name) => (name.startsWith('shadow-') ? ALPHA : 'regent'),
    states: { [ALPHA]: alphaState },
  });
}

function blockedSince(milliseconds: number): string {
  return new Date(NOW - milliseconds).toISOString();
}

test('an Alpha whose state file names a live child is not paged', async () => {
  const { dependencies, pages } = scenario({
    state: 'blocked',
    blockedBy: ['shadow-bakery-02-photos'],
    declaredAt: blockedSince(DELAY_BEFORE_TELLING_THE_REGENT_MS * 10),
  });

  await reconcileBlockedAgentPages(dependencies);

  assert.deepEqual(pages, []);
});

test('an Alpha whose state file is blocked with no child pages the Regent once the wake delay has passed, and only once', async () => {
  const { dependencies, pages, escalationLedger } = scenario({
    state: 'blocked',
    declaredAt: blockedSince(DELAY_BEFORE_TELLING_THE_REGENT_MS),
  });

  await reconcileBlockedAgentPages(dependencies);
  await reconcileBlockedAgentPages(dependencies);

  assert.equal(pages.length, 1, `expected one page, got ${JSON.stringify(pages)}`);
  assert.match(pages[0]!, /alpha-bakery-01 is blocked but names no child the sweep can read/);
  assert.match(pages[0]!, /worktree: \/worktrees\/alpha-bakery-01/);
  assert.equal(escalationLedger.filter((entry) => entry.kind === 'page-enqueued').length, 1);
});

test('an Alpha blocked with no child is not paged before the wake delay has passed', async () => {
  const { dependencies, pages } = scenario({
    state: 'blocked',
    declaredAt: blockedSince(DELAY_BEFORE_TELLING_THE_REGENT_MS - 1),
  });

  await reconcileBlockedAgentPages(dependencies);

  assert.deepEqual(pages, []);
});

test('a block the Regent recorded itself, which names no child by design, is not paged back to the Regent', async () => {
  const { dependencies, pages } = scenario({
    state: 'blocked',
    declaredBy: 'regent',
    declaredAt: blockedSince(DELAY_BEFORE_TELLING_THE_REGENT_MS * 10),
  });

  await reconcileBlockedAgentPages(dependencies);

  assert.deepEqual(pages, []);
});

test('an Alpha whose state file says working is not paged however old the declaration', async () => {
  const { dependencies, pages } = scenario({
    state: 'working',
    declaredAt: blockedSince(DELAY_BEFORE_TELLING_THE_REGENT_MS * 10),
  });

  await reconcileBlockedAgentPages(dependencies);

  assert.deepEqual(pages, []);
});
