import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  handlePaneAgentStatusChangedEvent,
  reconcileBlockedAgentPages,
} from './blocked-agent-paging.hosted-worker.ts';
import { fakeBlockedAgentPagingDependencies, type StoredBlockedMarker } from './blocked-agent-paging-test-fixtures.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { DELAY_BEFORE_TELLING_THE_REGENT_MS } from '../no-idling/dependency-cleared-wake.ts';

const OWN_BACKGROUND_RUN_MARKER = '{"blocked":true} BLOCKED_BY_own-background-run (candidate and base suites)';
const CAPTURED_PANE_WITH_THE_MARKER = (
  await readFile(
    path.join(import.meta.dirname, '..', 'no-idling', 'fixtures', 'claude-pane-waiting-on-queued-suite-runs.txt'),
    'utf8',
  )
).replace("when they report.\n", `when they report.\n\n  ${OWN_BACKGROUND_RUN_MARKER}\n`);

function paneEndingWith(message: string): string {
  return ['⏺ Both suite runs are queued for a container slot.', '', `  ${message}`, '', '✻ Crunched for 9s · done 4:36 PM', ''].join('\n');
}

const NOW = Date.parse('2026-10-15T09:00:00.000Z');
const SHADOW = 'shadow-bakery-99a-conform';
const ALPHA = 'alpha-bakery-01';
const SWEEPS = 4;

interface Scenario {
  readonly shadowStatus: AgentStatusesRosterEntry['liveStatus'];
  readonly panes: Readonly<Record<string, string>>;
  readonly alphaHasLiveChild?: boolean;
  readonly alphaBlockedAt?: string;
}

function scenario({ shadowStatus, panes, alphaHasLiveChild = false, alphaBlockedAt }: Scenario) {
  const blockedMarkers = new Map<string, StoredBlockedMarker>();
  if (alphaBlockedAt !== undefined) blockedMarkers.set(ALPHA, { blockedAt: alphaBlockedAt, blockedBy: [] });
  return fakeBlockedAgentPagingDependencies({
    now: NOW,
    roster: [
      { name: 'regent', lifecycle: 'live', liveStatus: 'working', reportLanded: false, focused: false, paneId: 'w1:p1' },
      { name: ALPHA, lifecycle: 'live', liveStatus: 'done', reportLanded: false, role: 'Alpha', focused: false, paneId: 'w1:p2' },
      { name: SHADOW, lifecycle: 'live', liveStatus: shadowStatus, reportLanded: false, role: 'Shadow', focused: false, paneId: 'w1:p3' },
    ],
    supervisorOf: (name) => (name === SHADOW && alphaHasLiveChild ? ALPHA : 'regent'),
    readAgent: async (name) => panes[name] ?? paneEndingWith('Working on it.'),
    blockedMarkers,
  });
}

function pagesAbout(pages: readonly string[], agent: string): string[] {
  return pages.filter((page) => page.includes(agent));
}

function shadowWaitingOnABackgroundRunThatIsNotRunning() {
  return scenario({ shadowStatus: 'done', panes: { [SHADOW]: paneEndingWith(OWN_BACKGROUND_RUN_MARKER) } });
}

function assertPagedOnceSayingNoBackgroundRunIsRunning(pages: readonly string[]): string {
  const shadowPages = pagesAbout(pages, SHADOW);
  assert.equal(shadowPages.length, 1, `expected one page, got ${JSON.stringify(pages)}`);
  assert.match(shadowPages[0]!, /it says it waits on its own background run, but none is running/);
  return shadowPages[0]!;
}

async function sweepRepeatedly(dependencies: Parameters<typeof reconcileBlockedAgentPages>[0]): Promise<void> {
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    await reconcileBlockedAgentPages(dependencies);
  }
}

test('a shadow waiting on its own background run with live work is not paged, not recorded and never reaches the lord', async () => {
  for (const shadowStatus of ['done', 'blocked'] as const) {
    const { dependencies, pages, escalationLedger, lordNotices } = scenario({
      shadowStatus,
      panes: { [SHADOW]: CAPTURED_PANE_WITH_THE_MARKER },
    });

    await sweepRepeatedly(dependencies);
    await handlePaneAgentStatusChangedEvent(
      { paneId: 'w1:p3', workspaceId: '', agentStatus: 'blocked', agent: null, displayAgent: null, title: null, stateLabels: {} },
      dependencies,
      new Set(),
    );

    assert.deepEqual(pagesAbout(pages, SHADOW), [], shadowStatus);
    assert.deepEqual(escalationLedger, [], shadowStatus);
    assert.deepEqual(lordNotices, [], shadowStatus);
  }
});

test('a shadow that says it waits on its own background run while none is running is paged to the regent once', async () => {
  const { dependencies, pages, lordNotices } = shadowWaitingOnABackgroundRunThatIsNotRunning();

  await sweepRepeatedly(dependencies);

  const page = assertPagedOnceSayingNoBackgroundRunIsRunning(pages);
  assert.doesNotMatch(page, /It is stuck/);
  assert.deepEqual(lordNotices, []);
});

function earlierPagesFor(agent: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    agentName: agent,
    observedAt: new Date(NOW - (index + 1) * 3_600_000).toISOString(),
    kind: 'page-enqueued' as const,
    pageKey: `blocked-agent-paging:${agent}:earlier-${index}`,
  }));
}

test('a session that says it waits on its own background run while none is running is paged to the regent once even after earlier pages', async () => {
  const { dependencies, pages, escalationLedger } = shadowWaitingOnABackgroundRunThatIsNotRunning();
  escalationLedger.push(...earlierPagesFor(SHADOW, 3));

  await sweepRepeatedly(dependencies);

  assertPagedOnceSayingNoBackgroundRunIsRunning(pages);
});

test('that page never notifies the lord', async () => {
  for (const earlierPages of [0, 2, 3]) {
    const { dependencies, escalationLedger, lordNotices } = shadowWaitingOnABackgroundRunThatIsNotRunning();
    escalationLedger.push(...earlierPagesFor(SHADOW, earlierPages));

    await sweepRepeatedly(dependencies);

    assert.deepEqual(lordNotices, [], `after ${earlierPages} earlier pages`);
  }
});

test('an alpha waiting on its own background run beside a live child is not paged as a nameless block', async () => {
  const { dependencies, pages } = scenario({
    shadowStatus: 'working',
    alphaHasLiveChild: true,
    alphaBlockedAt: new Date(NOW - DELAY_BEFORE_TELLING_THE_REGENT_MS).toISOString(),
    panes: { [ALPHA]: paneEndingWith('{"blocked":true} BLOCKED_BY_own-background-run (the merged candidate suite)') },
  });

  await sweepRepeatedly(dependencies);

  assert.deepEqual(pagesAbout(pages, ALPHA), []);
});

test('a blocked shadow that names no background run is still paged as stuck', async () => {
  const { dependencies, pages } = scenario({
    shadowStatus: 'done',
    panes: { [SHADOW]: paneEndingWith('{"blocked":true}') },
  });

  await reconcileBlockedAgentPages(dependencies);

  const shadowPages = pagesAbout(pages, SHADOW);
  assert.equal(shadowPages.length, 1, `expected one page, got ${JSON.stringify(pages)}`);
  assert.match(shadowPages[0]!, /It is stuck/);
});

test('a blocked shadow whose pane shows live background work but posted no own-background-run marker is still paged as stuck', async () => {
  const { dependencies, pages } = scenario({
    shadowStatus: 'done',
    panes: { [SHADOW]: CAPTURED_PANE_WITH_THE_MARKER.replace(OWN_BACKGROUND_RUN_MARKER, '{"blocked":true}') },
  });

  await reconcileBlockedAgentPages(dependencies);

  assert.match(pagesAbout(pages, SHADOW)[0] ?? '', /It is stuck/);
});

test('a session that twice says it waits on its own background run while none is running is paged once for each wait', async () => {
  for (const shadowStatus of ['done', 'blocked'] as const) {
    let now = NOW;
    let shadowPane = paneEndingWith(OWN_BACKGROUND_RUN_MARKER);
    const { dependencies, pages } = fakeBlockedAgentPagingDependencies({
      get now() {
        return now;
      },
      roster: [
        { name: 'regent', lifecycle: 'live', liveStatus: 'working', reportLanded: false, focused: false, paneId: 'w1:p1' },
        { name: SHADOW, lifecycle: 'live', liveStatus: shadowStatus, reportLanded: false, role: 'Shadow', focused: false, paneId: 'w1:p3' },
      ],
      supervisorOf: () => 'regent',
      readAgent: async () => shadowPane,
    });

    await sweepRepeatedly(dependencies);
    shadowPane = paneEndingWith('Both suites finished; reading the results now.');
    await reconcileBlockedAgentPages(dependencies);
    now += 3_600_000;
    shadowPane = paneEndingWith(OWN_BACKGROUND_RUN_MARKER);
    await sweepRepeatedly(dependencies);

    const noRunPages = pagesAbout(pages, SHADOW).filter((page) => page.includes('but none is running'));
    assert.equal(noRunPages.length, 2, `${shadowStatus}: ${JSON.stringify(pages)}`);
  }
});
