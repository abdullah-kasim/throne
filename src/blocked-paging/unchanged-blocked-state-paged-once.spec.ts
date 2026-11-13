import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reconcileBlockedAgentPages } from './blocked-agent-paging.hosted-worker.ts';
import { fakeBlockedAgentPagingDependencies, type StoredBlockedMarker } from './blocked-agent-paging-test-fixtures.ts';
import { UNCHANGED_OBSERVATION_REPAGE_INTERVAL_MS } from './blocked-agent-escalation-ledger.ts';
import type { AgentPresentState } from '../agentdata/agent-present-state.ts';

const STUCK_SHADOW = 'shadow-rptheadnum-99c-deliver';
const FIRST_PAGE_AT = Date.parse('2026-11-10T18:24:05.000Z');
const BLOCKED_PANE = ['⏺ Waiting.', '', '  {"blocked":true}', ''].join('\n');

function courtWithBlockedShadow(options: {
  readonly reportLanded?: boolean;
  readonly presentState?: AgentPresentState;
  readonly marker?: StoredBlockedMarker;
} = {}) {
  const blockedMarkers = new Map<string, StoredBlockedMarker>();
  blockedMarkers.set(STUCK_SHADOW, options.marker ?? { blockedAt: '2026-11-10T18:20:00.000Z' });
  let now = FIRST_PAGE_AT;
  const court = fakeBlockedAgentPagingDependencies({
    now,
    roster: [
      { name: 'regent', lifecycle: 'live', liveStatus: 'working', reportLanded: false, focused: false, paneId: 'w1:p1' },
      { name: STUCK_SHADOW, lifecycle: 'live', liveStatus: 'blocked', reportLanded: options.reportLanded ?? false, role: 'Shadow', focused: false, paneId: 'w1:p9QX' },
    ],
    supervisorOf: () => 'regent',
    readAgent: async () => BLOCKED_PANE,
    blockedMarkers,
    presentStateOf: () => options.presentState ?? { reaped: false, withinSpawnGrace: false },
  });
  const dependencies = { ...court.dependencies, now: () => now };
  return {
    ...court,
    blockedMarkers,
    sweepAt: async (atMs: number) => {
      now = atMs;
      await reconcileBlockedAgentPages(dependencies);
    },
  };
}

for (const campaign of ['merging', 'verdict-only'] as const) {
  test(`an unchanged blocked state is paged once and not again within the interval (${campaign} Shadow)`, async () => {
    const court = courtWithBlockedShadow();
    await court.sweepAt(FIRST_PAGE_AT);
    await court.sweepAt(FIRST_PAGE_AT + 93_000);
    await court.sweepAt(FIRST_PAGE_AT + 176_000);
    assert.equal(court.pages.length, 1);
    await court.sweepAt(FIRST_PAGE_AT + UNCHANGED_OBSERVATION_REPAGE_INTERVAL_MS);
    assert.equal(court.pages.length, 2);
  });

  test(`a changed blocked marker is paged at once (${campaign} Shadow)`, async () => {
    const court = courtWithBlockedShadow();
    await court.sweepAt(FIRST_PAGE_AT);
    court.blockedMarkers.set(STUCK_SHADOW, { blockedAt: '2026-11-10T18:24:30.000Z' });
    await court.sweepAt(FIRST_PAGE_AT + 60_000);
    assert.equal(court.pages.length, 2);
  });

  test(`a blocked agent whose transcript is still being written is not paged as stuck (${campaign} Shadow)`, async () => {
    const court = courtWithBlockedShadow({
      presentState: { reaped: false, withinSpawnGrace: false, lastTranscriptWriteMs: FIRST_PAGE_AT - 20_000 },
    });
    await court.sweepAt(FIRST_PAGE_AT);
    assert.deepEqual(court.pages, []);
  });

  test(`a block passed over while its transcript was fresh is paged on a later sweep once it goes quiet (${campaign} Shadow)`, async () => {
    const court = courtWithBlockedShadow({
      presentState: { reaped: false, withinSpawnGrace: false, lastTranscriptWriteMs: FIRST_PAGE_AT - 20_000 },
    });
    await court.sweepAt(FIRST_PAGE_AT);
    assert.deepEqual(court.pages, []);
    await court.sweepAt(FIRST_PAGE_AT + 2 * 60_000);
    assert.equal(court.pages.length, 1);
  });

  test(`a blocked agent whose transcript went quiet is still paged as stuck (${campaign} Shadow)`, async () => {
    const court = courtWithBlockedShadow({
      presentState: { reaped: false, withinSpawnGrace: false, lastTranscriptWriteMs: FIRST_PAGE_AT - 10 * 60_000 },
    });
    await court.sweepAt(FIRST_PAGE_AT);
    assert.equal(court.pages.length, 1);
  });

  test(`a reaped agent whose pane is still open is never paged (${campaign} Shadow)`, async () => {
    const court = courtWithBlockedShadow({ presentState: { reaped: true, withinSpawnGrace: false } });
    await court.sweepAt(FIRST_PAGE_AT);
    assert.deepEqual(court.pages, []);
  });
}

test('the escalation bound still tells the Lord once an unchanged block has been paged three times', async () => {
  const court = courtWithBlockedShadow();
  for (let page = 0; page < 4; page += 1) {
    await court.sweepAt(FIRST_PAGE_AT + page * UNCHANGED_OBSERVATION_REPAGE_INTERVAL_MS);
  }
  assert.equal(court.pages.length, 3);
  assert.equal(court.lordNotices.length, 1);
});
