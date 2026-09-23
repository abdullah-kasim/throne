import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyCandidateThroneTab,
  splitStaleAndStrandedThroneTabs,
  type CandidatePaneReads,
  type StaleTabReport,
} from './stale-tab-report.ts';
import type { HerdrPane } from '../herdr/herdr-inventory.service.ts';

function candidatePane(label: string, tabId: string, paneId: string): HerdrPane {
  return { paneId, tabId, terminalId: `term-${paneId}` };
}

function candidate(label: string, tabId: string): StaleTabReport {
  return { label, tabId, paneCount: 1, reason: `label exactly matches a throne ledger agent name (${label})` };
}

function readsThatSucceedWith(paneAnsi: string): CandidatePaneReads {
  return {
    readVisibleAnsi: async () => paneAnsi,
    fileExists: async () => true,
    readSpawnSpec: async () => null,
  };
}

function readsThatFailWith(error: unknown): CandidatePaneReads {
  return {
    readVisibleAnsi: async () => {
      throw error;
    },
    fileExists: async () => true,
    readSpawnSpec: async () => null,
  };
}

test('the stale-tab sweep evaluates the readable panes when the middle candidate\'s pane read fails with agent_not_found', async () => {
  const alpha = candidate('shadow-alpha', 'tab-alpha');
  const middle = candidate('shadow-middle', 'tab-middle');
  const beta = candidate('shadow-beta', 'tab-beta');
  const panes: HerdrPane[] = [
    candidatePane('shadow-alpha', 'tab-alpha', 'pane-alpha'),
    candidatePane('shadow-middle', 'tab-middle', 'pane-middle'),
    candidatePane('shadow-beta', 'tab-beta', 'pane-beta'),
  ];
  const ledgerNames = new Set(['shadow-alpha', 'shadow-middle', 'shadow-beta']);
  const readsByPane: Record<string, CandidatePaneReads> = {
    'pane-alpha': readsThatSucceedWith(''),
    'pane-middle': readsThatFailWith(Object.assign(new Error('pane gone'), { code: 'agent_not_found' })),
    'pane-beta': readsThatSucceedWith(''),
  };
  const routedReads: CandidatePaneReads = {
    readVisibleAnsi: async (paneId: string) => readsByPane[paneId].readVisibleAnsi(paneId),
    fileExists: async (filePath: string) => true,
    readSpawnSpec: async () => null,
  };
  const { staleTabs, strandedSpawns, unreadablePanes } = await splitStaleAndStrandedThroneTabs(
    [alpha, middle, beta],
    ledgerNames,
    panes,
    undefined,
    routedReads,
  );
  assert.deepEqual(
    staleTabs.map((tab) => tab.label).sort(),
    ['shadow-alpha', 'shadow-beta'],
  );
  assert.deepEqual(strandedSpawns, []);
  assert.equal(unreadablePanes.length, 1);
  assert.equal(unreadablePanes[0].label, 'shadow-middle');
});

test('the stale-tab sweep records an unreadable pane with its herdr error when a candidate\'s pane read fails', async () => {
  const target = candidate('shadow-target', 'tab-target');
  const panes: HerdrPane[] = [candidatePane('shadow-target', 'tab-target', 'pane-target')];
  const ledgerNames = new Set(['shadow-target']);
  const reads = readsThatFailWith(new Error('agent_not_found: pane-target'));
  const classified = await classifyCandidateThroneTab(target, ledgerNames, panes, undefined, reads);
  assert.deepEqual(classified, {
    kind: 'unreadable',
    report: {
      label: 'shadow-target',
      tabId: 'tab-target',
      paneId: 'pane-target',
      error: 'agent_not_found: pane-target',
    },
  });
});

test('the stale-tab sweep records an unreadable pane the same way when the pane read throws an error herdr has never named before', async () => {
  const target = candidate('shadow-target', 'tab-target');
  const panes: HerdrPane[] = [candidatePane('shadow-target', 'tab-target', 'pane-target')];
  const ledgerNames = new Set(['shadow-target']);
  const reads = readsThatFailWith('a raw string thrown by an unrecognized failure');
  const classified = await classifyCandidateThroneTab(target, ledgerNames, panes, undefined, reads);
  assert.deepEqual(classified, {
    kind: 'unreadable',
    report: {
      label: 'shadow-target',
      tabId: 'tab-target',
      paneId: 'pane-target',
      error: 'a raw string thrown by an unrecognized failure',
    },
  });
});

test('the stale-tab sweep still classifies every candidate as stale or stranded exactly as before when every pane is readable', async () => {
  const alpha = candidate('shadow-alpha', 'tab-alpha');
  const beta = candidate('shadow-beta', 'tab-beta');
  const panes: HerdrPane[] = [
    candidatePane('shadow-alpha', 'tab-alpha', 'pane-alpha'),
    candidatePane('shadow-beta', 'tab-beta', 'pane-beta'),
  ];
  const ledgerNames = new Set(['shadow-alpha', 'shadow-beta']);
  const reads = readsThatSucceedWith('');
  const { staleTabs, strandedSpawns, unreadablePanes } = await splitStaleAndStrandedThroneTabs(
    [alpha, beta],
    ledgerNames,
    panes,
    undefined,
    reads,
  );
  assert.deepEqual(
    staleTabs.map((tab) => tab.label).sort(),
    ['shadow-alpha', 'shadow-beta'],
  );
  assert.deepEqual(strandedSpawns, []);
  assert.deepEqual(unreadablePanes, []);
});
