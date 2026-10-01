import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { reconcileBlockedAgentPages } from './blocked-agent-paging.hosted-worker.ts';
import type { BlockedAgentPagingDependencies } from './blocked-agent-paging-dependencies.types.ts';
import type { BlockedPageLedgerEntry } from './blocked-agent-escalation-ledger.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import type { HerdrAgent } from '../herdr/herdr-identity-contracts.ts';
import { DELAY_BEFORE_TELLING_THE_REGENT_MS } from '../no-idling/dependency-cleared-wake.ts';

const RENDERED_ALPHA_PANE = await readFile(
  path.join(import.meta.dirname, '..', 'no-idling', 'fixtures', 'claude-pane-bold-stripped-blocked-marker.txt'),
  'utf8',
);
const RENDERED_ALPHA_PANE_NAMING_NO_CHILD = [
  '⏺ Slice 02 is photographing the menu. Waiting on it.',
  '',
  '  {"blocked":true}',
  '',
  '✻ Crunched for 9s · done 3:30 PM',
  '',
].join('\n');
const NOW = Date.parse('2026-09-28T08:00:00.000Z');

interface StoredMarker {
  blockedAt: string;
  origin?: 'agent' | 'regent';
  blockedBy?: readonly string[];
}

function scenario(alphaPane: string, storedMarker?: StoredMarker) {
  const pages: string[] = [];
  const escalationLedger: BlockedPageLedgerEntry[] = [];
  const blockedMarkers = new Map<string, StoredMarker>();
  if (storedMarker !== undefined) blockedMarkers.set('alpha-bakery-01', storedMarker);
  const roster: AgentStatusesRosterEntry[] = [
    { name: 'regent', lifecycle: 'live', liveStatus: 'working', reportLanded: false, focused: false, paneId: 'w1:p1' },
    { name: 'alpha-bakery-01', lifecycle: 'live', liveStatus: 'done', reportLanded: false, role: 'Alpha', focused: false, paneId: 'w1:p2', cwd: '/worktrees/alpha-bakery-01' },
    { name: 'shadow-bakery-02-photos', lifecycle: 'live', liveStatus: 'working', reportLanded: false, role: 'Shadow', focused: false, paneId: 'w1:p3' },
  ];
  const dependencies: BlockedAgentPagingDependencies = {
    herdrClient: {} as never,
    listKnownPaneIds: async () => [],
    getRoster: async () => roster,
    readAgentSupervisor: async (name) => (name.startsWith('shadow-') ? 'alpha-bakery-01' : 'regent'),
    readAgent: async (name) => {
      if (name === 'alpha-bakery-01') return alphaPane;
      throw new Error(`herdr agent read ${name} failed (agent_not_idle)`);
    },
    readVisiblePaneText: async () => '',
    blockedMarkerLedger: {
      readBlockedMarker: async (name) => blockedMarkers.get(name) ?? null,
      writeBlockedMarker: async (name, blockedBy) => {
        blockedMarkers.set(name, { blockedAt: new Date(NOW).toISOString(), blockedBy });
      },
      clearBlockedMarker: async (name) => {
        blockedMarkers.delete(name);
      },
    },
    resolveAgent: async (name) => ({ name, paneId: 'w1:p1' }) as HerdrAgent,
    submitToAgent: async (_target, _sender, prompt) => {
      pages.push(prompt);
    },
    sleep: async () => undefined,
    readEscalationLedger: async () => escalationLedger,
    appendEscalationLedger: async (entry) => {
      escalationLedger.push(entry);
    },
    notifyLord: async () => true,
    now: () => NOW,
    stderr: () => undefined,
  };
  return { dependencies, pages, escalationLedger, blockedMarkers };
}

function blockedSince(milliseconds: number): string {
  return new Date(NOW - milliseconds).toISOString();
}

test('blocked paging reads the child name from a rendered pane and does not page an Alpha that names a live child', async () => {
  const { dependencies, pages, blockedMarkers } = scenario(RENDERED_ALPHA_PANE, {
    blockedAt: blockedSince(DELAY_BEFORE_TELLING_THE_REGENT_MS),
    blockedBy: [],
  });

  await reconcileBlockedAgentPages(dependencies);

  assert.deepEqual(blockedMarkers.get('alpha-bakery-01')?.blockedBy, ['shadow-bakery-02-photos']);
  assert.deepEqual(pages, []);
});

test('an Alpha blocked with no readable child pages the Regent once the wake delay has passed, and only once', async () => {
  const { dependencies, pages, escalationLedger } = scenario(RENDERED_ALPHA_PANE_NAMING_NO_CHILD, {
    blockedAt: blockedSince(DELAY_BEFORE_TELLING_THE_REGENT_MS),
    blockedBy: [],
  });

  await reconcileBlockedAgentPages(dependencies);
  await reconcileBlockedAgentPages(dependencies);

  assert.equal(pages.length, 1, `expected one page, got ${JSON.stringify(pages)}`);
  assert.match(pages[0]!, /alpha-bakery-01 is blocked but names no child the sweep can read/);
  assert.match(pages[0]!, /worktree: \/worktrees\/alpha-bakery-01/);
  assert.equal(escalationLedger.filter((entry) => entry.kind === 'page-enqueued').length, 1);
});

test('an Alpha blocked with no readable child is not paged before the wake delay has passed', async () => {
  const { dependencies, pages } = scenario(RENDERED_ALPHA_PANE_NAMING_NO_CHILD, {
    blockedAt: blockedSince(DELAY_BEFORE_TELLING_THE_REGENT_MS - 1),
    blockedBy: [],
  });

  await reconcileBlockedAgentPages(dependencies);

  assert.deepEqual(pages, []);
});

test('a block the Regent recorded itself, which names no child by design, is not paged back to the Regent', async () => {
  const { dependencies, pages } = scenario(RENDERED_ALPHA_PANE_NAMING_NO_CHILD, {
    blockedAt: blockedSince(DELAY_BEFORE_TELLING_THE_REGENT_MS * 10),
    origin: 'regent',
  });

  await reconcileBlockedAgentPages(dependencies);

  assert.deepEqual(pages, []);
});
