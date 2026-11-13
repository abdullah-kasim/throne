import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  handlePaneAgentStatusChangedEvent,
  reconcileBlockedAgentPages,
} from './blocked-agent-paging.hosted-worker.ts';
import { fakeBlockedAgentPagingDependencies, type DeclaredState } from './blocked-agent-paging-test-fixtures.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { DELAY_BEFORE_TELLING_THE_REGENT_MS } from '../no-idling/dependency-cleared-wake.ts';
import type { HarnessBackgroundWorkHost } from '../process-inspection/harness-background-work.ts';
import {
  harnessProcessHost,
  processTableCapture,
  PROCESS_HOST_WITHOUT_HERDR,
} from '../process-inspection/harness-background-work-test-fixtures.ts';

const SHADOW_WORKTREE = await realpath(await mkdtemp(path.join(tmpdir(), 'waiting-agent-worktree-')));
const IDLE_HARNESS = harnessProcessHost({
  processTable: await processTableCapture('macos-claude-idle-harness'),
  harnessDirectory: SHADOW_WORKTREE,
});
const HARNESS_WITH_BACKGROUND_HOLD_SCRIPT = harnessProcessHost({
  processTable: await processTableCapture('macos-claude-harness-with-background-hold-script'),
  harnessDirectory: SHADOW_WORKTREE,
});
const HARNESS_WITH_NOHUP_SUITE_IN_WORKTREE = harnessProcessHost({
  processTable: await processTableCapture('macos-claude-harness-with-nohup-suite-in-worktree'),
  harnessDirectory: SHADOW_WORKTREE,
  pidsInHarnessDirectory: [71120, 71135, 71136, 71180],
});

const NOW = Date.parse('2026-10-15T09:00:00.000Z');
const WAITING_ON_OWN_RUN: DeclaredState = {
  state: 'waiting-on-own-run',
  waitingOn: 'candidate and base suites',
  declaredAt: new Date(NOW - 60_000).toISOString(),
};
const BLOCKED_NAMING_NO_CHILD: DeclaredState = { state: 'blocked', declaredAt: new Date(NOW - 60_000).toISOString() };
const SHADOW = 'shadow-bakery-99a-conform';
const ALPHA = 'alpha-bakery-01';
const SWEEPS = 4;

interface Scenario {
  readonly shadowStatus: AgentStatusesRosterEntry['liveStatus'];
  readonly states: Readonly<Record<string, DeclaredState>>;
  readonly shadowProcesses?: HarnessBackgroundWorkHost;
  readonly alphaHasLiveChild?: boolean;
}

function scenario({ shadowStatus, states, shadowProcesses = IDLE_HARNESS, alphaHasLiveChild = false }: Scenario) {
  return fakeBlockedAgentPagingDependencies({
    now: NOW,
    roster: [
      { name: 'regent', lifecycle: 'live', liveStatus: 'working', reportLanded: false, focused: false, paneId: 'w1:p1' },
      { name: ALPHA, lifecycle: 'live', liveStatus: 'done', reportLanded: false, role: 'Alpha', focused: false, paneId: 'w1:p2' },
      { name: SHADOW, lifecycle: 'live', liveStatus: shadowStatus, reportLanded: false, role: 'Shadow', focused: false, paneId: 'w1:p3' },
    ],
    supervisorOf: (name) => (name === SHADOW && alphaHasLiveChild ? ALPHA : 'regent'),
    states,
    processHostOfPane: (paneId) => (paneId === 'w1:p3' ? shadowProcesses : IDLE_HARNESS),
  });
}

function pagesAbout(pages: readonly string[], agent: string): string[] {
  return pages.filter((page) => page.includes(agent));
}

function shadowWaitingOnABackgroundRunThatIsNotRunning() {
  return scenario({ shadowStatus: 'done', states: { [SHADOW]: WAITING_ON_OWN_RUN } });
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

async function assertNeverPagedRecordedOrSentToTheLord(shadowProcesses: HarnessBackgroundWorkHost): Promise<void> {
  for (const shadowStatus of ['done', 'blocked'] as const) {
    const { dependencies, pages, escalationLedger, lordNotices } = scenario({
      shadowStatus,
      states: { [SHADOW]: WAITING_ON_OWN_RUN },
      shadowProcesses,
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
}

test('an agent blocked on its own background run is not paged while its background hold script is alive', async () => {
  await assertNeverPagedRecordedOrSentToTheLord(HARNESS_WITH_BACKGROUND_HOLD_SCRIPT);
});

test('an agent blocked on its own background run is not paged while a suite it started with nohup is still running in its worktree', async () => {
  await assertNeverPagedRecordedOrSentToTheLord(HARNESS_WITH_NOHUP_SUITE_IN_WORKTREE);
});

test('a pane whose processes cannot be read is not paged as having no background run', async () => {
  await assertNeverPagedRecordedOrSentToTheLord(PROCESS_HOST_WITHOUT_HERDR);
});

test('an agent blocked on its own background run is not paged while herdr reports its pane working, as it does while a background agent runs', async () => {
  const { dependencies, pages, escalationLedger } = scenario({
    shadowStatus: 'working',
    states: { [SHADOW]: WAITING_ON_OWN_RUN },
  });

  await sweepRepeatedly(dependencies);

  assert.deepEqual(pagesAbout(pages, SHADOW), []);
  assert.deepEqual(escalationLedger, []);
});

test('an agent blocked on its own background run is paged when no work it started is alive', async () => {
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
    states: {
      [ALPHA]: {
        state: 'waiting-on-own-run',
        waitingOn: 'the merged candidate suite',
        declaredAt: new Date(NOW - DELAY_BEFORE_TELLING_THE_REGENT_MS).toISOString(),
      },
    },
  });

  await sweepRepeatedly(dependencies);

  assert.deepEqual(pagesAbout(pages, ALPHA), []);
});

test('a blocked shadow that names no background run is still paged as stuck', async () => {
  const { dependencies, pages } = scenario({
    shadowStatus: 'done',
    states: { [SHADOW]: BLOCKED_NAMING_NO_CHILD },
  });

  await reconcileBlockedAgentPages(dependencies);

  const shadowPages = pagesAbout(pages, SHADOW);
  assert.equal(shadowPages.length, 1, `expected one page, got ${JSON.stringify(pages)}`);
  assert.match(shadowPages[0]!, /It is stuck/);
});

test('a blocked shadow whose harness runs background work but declared no wait on its own run is still paged as stuck', async () => {
  const { dependencies, pages } = scenario({
    shadowStatus: 'done',
    states: { [SHADOW]: BLOCKED_NAMING_NO_CHILD },
    shadowProcesses: HARNESS_WITH_BACKGROUND_HOLD_SCRIPT,
  });

  await reconcileBlockedAgentPages(dependencies);

  assert.match(pagesAbout(pages, SHADOW)[0] ?? '', /It is stuck/);
});

test('a session that twice says it waits on its own background run while none is running is paged once for each wait', async () => {
  for (const shadowStatus of ['done', 'blocked'] as const) {
    let now = NOW;
    const { dependencies, pages, declareState } = fakeBlockedAgentPagingDependencies({
      get now() {
        return now;
      },
      roster: [
        { name: 'regent', lifecycle: 'live', liveStatus: 'working', reportLanded: false, focused: false, paneId: 'w1:p1' },
        { name: SHADOW, lifecycle: 'live', liveStatus: shadowStatus, reportLanded: false, role: 'Shadow', focused: false, paneId: 'w1:p3' },
      ],
      supervisorOf: () => 'regent',
      states: { [SHADOW]: WAITING_ON_OWN_RUN },
      processHostOfPane: () => IDLE_HARNESS,
    });

    await sweepRepeatedly(dependencies);
    declareState(SHADOW, { state: 'working', declaredAt: new Date(now).toISOString() });
    await reconcileBlockedAgentPages(dependencies);
    now += 3_600_000;
    declareState(SHADOW, { ...WAITING_ON_OWN_RUN, declaredAt: new Date(now).toISOString() });
    await sweepRepeatedly(dependencies);

    const noRunPages = pagesAbout(pages, SHADOW).filter((page) => page.includes('but none is running'));
    assert.equal(noRunPages.length, 2, `${shadowStatus}: ${JSON.stringify(pages)}`);
  }
});
