import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  handlePaneAgentStatusChangedEvent,
  reconcileBlockedAgentPages,
} from './blocked-agent-paging.hosted-worker.ts';
import { fakeBlockedAgentPagingDependencies, type DeclaredState } from './blocked-agent-paging-test-fixtures.ts';
import { ACCEPTANCE_DATA } from '../agentdata/acceptance-data.service.ts';
import { DELIVERY_EVIDENCE_DATA } from '../agentdata/delivery-evidence-data.service.ts';
import { readSupervisorWait } from '../supervisor-wait/read-supervisor-wait.ts';

const NOW = Date.parse('2026-11-10T18:24:05.548Z');
const SWEEPS = 4;
const REGENT_STUCK_PAGE = 'is not a supervising Alpha with a live child';

interface RegentFalseAlarm {
  readonly messageIds: readonly number[];
  readonly shadow: string;
  readonly alpha: string;
}

const MERGED_SHADOWS_THE_REGENT_WAS_PAGED_ABOUT: readonly RegentFalseAlarm[] = [
  { messageIds: [101], shadow: 'shadow-mapseamskill-99c-deliver', alpha: 'alpha-mapseamskill-01' },
  { messageIds: [102], shadow: 'shadow-rptheadnum-99b-verify', alpha: 'alpha-rptheadnum-01' },
  { messageIds: [103, 104, 105], shadow: 'shadow-rptheadnum-99c-deliver', alpha: 'alpha-rptheadnum-01' },
];

type Ledger =
  | 'reported-only'
  | 'merged-without-report'
  | 'nothing'
  | 'verdict-accepted-with-go-ahead'
  | 'messaged-supervisor-only';

interface Court {
  readonly shadow: string;
  readonly alpha: string;
  readonly ledger: Ledger;
  readonly blockedOn?: string;
  readonly declared?: DeclaredState;
  readonly shadowStatus?: 'done' | 'blocked';
}

async function writeLedger(dataDir: string, { shadow, alpha, ledger }: Court): Promise<void> {
  const dir = path.join(dataDir, shadow);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'identity.md'), `# ${shadow}\n\n- **Role:** Shadow\n- **Supervisor (routine):** ${alpha}\n`);
  if (ledger === 'reported-only' || ledger === 'verdict-accepted-with-go-ahead') {
    await writeFile(path.join(dir, 'REPORT.md'), 'DONE\n');
  }
  if (ledger === 'messaged-supervisor-only') {
    await writeFile(
      path.join(dir, 'sent-messages.jsonl'),
      `${JSON.stringify({ timestamp: '2026-11-11T10:36:47.000Z', recipient: alpha, id: '9', transport: 'sqlite' })}\n`,
    );
  }
  if (ledger === 'merged-without-report') {
    await DELIVERY_EVIDENCE_DATA.write(shadow, { repo: '/repos/bakery', targetBranch: alpha, commit: 'abc123' }, dataDir);
  }
  if (ledger === 'verdict-accepted-with-go-ahead') {
    await ACCEPTANCE_DATA.write(
      shadow,
      {
        acceptedAt: '2026-11-10T18:20:00.000Z',
        by: alpha,
        how: 'verdict',
        goAhead: { sentAt: '2026-11-10T18:20:01.000Z', sendOutcome: 'enqueued' },
      },
      dataDir,
    );
  }
}

async function withCourt(court: Court, run: (fake: ReturnType<typeof fakeBlockedAgentPagingDependencies>) => Promise<void>) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'supervisor-wait-page-'));
  try {
    await writeLedger(dataDir, court);
    const fake = fakeBlockedAgentPagingDependencies({
      now: NOW,
      roster: [
        { name: 'regent', lifecycle: 'live', liveStatus: 'working', reportLanded: false, focused: false, paneId: 'w1:p5' },
        { name: court.alpha, lifecycle: 'live', liveStatus: 'done', reportLanded: false, role: 'Alpha', focused: false, paneId: 'w1:p2' },
        {
          name: court.shadow,
          lifecycle: 'live',
          liveStatus: court.shadowStatus ?? 'done',
          reportLanded: court.ledger === 'reported-only' || court.ledger === 'verdict-accepted-with-go-ahead',
          role: 'Shadow',
          focused: false,
          paneId: 'w1:p3',
        },
      ],
      supervisorOf: (name) => (name === court.shadow ? court.alpha : 'regent'),
      stateFolder: dataDir,
      states: {
        [court.shadow]: court.declared ?? {
          state: 'blocked',
          blockedBy: [court.blockedOn ?? court.alpha],
          declaredAt: new Date(NOW - 60_000).toISOString(),
        },
      },
      readSupervisorWait: (agentName) => readSupervisorWait({ agentName, dataDir }),
    });
    await run(fake);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function sweepRepeatedly(dependencies: Parameters<typeof reconcileBlockedAgentPages>[0]): Promise<void> {
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    await reconcileBlockedAgentPages(dependencies);
  }
}

function pagesTo(fake: ReturnType<typeof fakeBlockedAgentPagingDependencies>, recipient: string): string[] {
  return fake.pages.filter((_page, index) => fake.recipients[index]?.toLowerCase() === recipient.toLowerCase());
}

test('a Shadow blocked on its supervisor before reporting DONE or being accepted is still paged to the regent as stuck', async () => {
  await withCourt({ shadow: 'shadow-scratch-01-slice', alpha: 'alpha-scratch-01', ledger: 'nothing' }, async (fake) => {
    await sweepRepeatedly(fake.dependencies);
    assert.ok(pagesTo(fake, 'regent').some((page) => page.includes(REGENT_STUCK_PAGE)));
    assert.deepEqual(pagesTo(fake, 'alpha-scratch-01'), []);
  });
});

test('a merged Shadow blocked on someone other than its supervisor is still paged to the regent as stuck', async () => {
  await withCourt(
    { shadow: 'shadow-scratch-01-slice', alpha: 'alpha-scratch-01', ledger: 'merged-without-report', blockedOn: 'shadow-scratch-02-slice' },
    async (fake) => {
      await sweepRepeatedly(fake.dependencies);
      assert.ok(pagesTo(fake, 'regent').some((page) => page.includes(REGENT_STUCK_PAGE)));
      assert.deepEqual(pagesTo(fake, 'alpha-scratch-01'), []);
    },
  );
});

for (const alarm of MERGED_SHADOWS_THE_REGENT_WAS_PAGED_ABOUT) {
  test(`a merged Shadow waiting on its own Alpha is not paged to the regent, replaying regent messages ${alarm.messageIds.join(', ')}`, async () => {
    await withCourt({ shadow: alarm.shadow, alpha: alarm.alpha, ledger: 'merged-without-report' }, async (fake) => {
      await sweepRepeatedly(fake.dependencies);
      assert.deepEqual(pagesTo(fake, 'regent'), []);
      assert.equal(fake.lordNotices.length, 0);
    });
  });

  test(`the Alpha of a merged Shadow is paged once to send the go-ahead, replaying regent messages ${alarm.messageIds.join(', ')}`, async () => {
    await withCourt({ shadow: alarm.shadow, alpha: alarm.alpha, ledger: 'merged-without-report' }, async (fake) => {
      await sweepRepeatedly(fake.dependencies);
      const alphaPages = pagesTo(fake, alarm.alpha);
      assert.equal(alphaPages.length, 1);
      assert.match(alphaPages[0] ?? '', new RegExp(`${alarm.shadow} .*you may publish your reapability claim`));
    });
  });
}

test('a merged Shadow that turns blocked on its own Alpha pages the Alpha and not the regent', async () => {
  await withCourt(
    { shadow: 'shadow-rptheadnum-99c-deliver', alpha: 'alpha-rptheadnum-01', ledger: 'merged-without-report', shadowStatus: 'blocked' },
    async (fake) => {
      await handlePaneAgentStatusChangedEvent(
        { paneId: 'w1:p3', workspaceId: 'w1', agentStatus: 'blocked', agent: 'claude', displayAgent: 'Claude', title: null, stateLabels: {} },
        fake.dependencies,
        new Set<string>(),
      );
      assert.deepEqual(pagesTo(fake, 'regent'), []);
      assert.equal(pagesTo(fake, 'alpha-rptheadnum-01').length, 1);
    },
  );
});

test('a verdict-only Shadow that reported DONE and waits on its own Alpha is not paged to the regent and its Alpha is told to merge or accept it', async () => {
  await withCourt({ shadow: 'shadow-rptreport-02-findings', alpha: 'alpha-rptreport-01', ledger: 'reported-only' }, async (fake) => {
    await sweepRepeatedly(fake.dependencies);
    assert.deepEqual(pagesTo(fake, 'regent'), []);
    const alphaPages = pagesTo(fake, 'alpha-rptreport-01');
    assert.equal(alphaPages.length, 1);
    assert.match(alphaPages[0] ?? '', /merge or accept shadow-rptreport-02-findings/);
  });
});

test('a verdict-only Shadow given its go-ahead but still waiting on its Alpha has its Alpha told to have it claim', async () => {
  await withCourt(
    { shadow: 'shadow-rptreport-02-findings', alpha: 'alpha-rptreport-01', ledger: 'verdict-accepted-with-go-ahead' },
    async (fake) => {
      await sweepRepeatedly(fake.dependencies);
      assert.deepEqual(pagesTo(fake, 'regent'), []);
      const alphaPages = pagesTo(fake, 'alpha-rptreport-01');
      assert.equal(alphaPages.length, 1);
      assert.match(alphaPages[0] ?? '', /\{"reapable":"completed"\}/);
    },
  );
});

const UNMERGED_PROOF_RUN = { shadow: 'shadow-holdwaitproof-run3', alpha: 'alpha-holdwaitproof-01' };

for (const kind of ['merging', 'verdict-only']) {
  test(`a ${kind} Shadow that reported DONE and waits for its merge does not page the Regent`, async () => {
    await withCourt({ ...UNMERGED_PROOF_RUN, ledger: 'messaged-supervisor-only' }, async (fake) => {
      await sweepRepeatedly(fake.dependencies);
      assert.deepEqual(pagesTo(fake, 'regent'), []);
      assert.equal(fake.lordNotices.length, 0);
    });
  });

  test(`the supervisor of a ${kind} Shadow that reported DONE before its merge is told to merge or accept it`, async () => {
    await withCourt({ ...UNMERGED_PROOF_RUN, ledger: 'messaged-supervisor-only' }, async (fake) => {
      await sweepRepeatedly(fake.dependencies);
      const alphaPages = pagesTo(fake, UNMERGED_PROOF_RUN.alpha);
      assert.equal(alphaPages.length, 1);
      assert.match(alphaPages[0] ?? '', /merge or accept shadow-holdwaitproof-run3/);
    });
  });

  test(`a ${kind} Shadow blocked on its supervisor that never messaged it is still paged as before`, async () => {
    await withCourt({ ...UNMERGED_PROOF_RUN, ledger: 'nothing' }, async (fake) => {
      await sweepRepeatedly(fake.dependencies);
      assert.ok(pagesTo(fake, 'regent').some((page) => page.includes(REGENT_STUCK_PAGE)));
      assert.deepEqual(pagesTo(fake, UNMERGED_PROOF_RUN.alpha), []);
    });
  });
}

test('a merged Shadow whose state file says it waits on its supervisor pages the Alpha and not the regent', async () => {
  await withCourt(
    {
      shadow: 'shadow-rptheadnum-99c-deliver',
      alpha: 'alpha-rptheadnum-01',
      ledger: 'merged-without-report',
      declared: { state: 'waiting-on-supervisor', declaredAt: new Date(NOW - 60_000).toISOString() },
    },
    async (fake) => {
      await sweepRepeatedly(fake.dependencies);
      assert.deepEqual(pagesTo(fake, 'regent'), []);
      assert.equal(pagesTo(fake, 'alpha-rptheadnum-01').length, 1);
    },
  );
});

test('a merged Shadow whose state file says working pages neither its Alpha nor the regent', async () => {
  await withCourt(
    {
      shadow: 'shadow-rptheadnum-99c-deliver',
      alpha: 'alpha-rptheadnum-01',
      ledger: 'merged-without-report',
      declared: { state: 'working', declaredAt: new Date(NOW - 60_000).toISOString() },
    },
    async (fake) => {
      await sweepRepeatedly(fake.dependencies);
      assert.deepEqual(fake.pages, []);
    },
  );
});
