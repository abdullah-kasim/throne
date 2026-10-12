import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseHerdrAgentList } from '../agent-statuses/agent-statuses-herdr.ts';
import type { HerdrTab } from '../herdr/herdr-inventory.service.ts';
import { collectThroneLedgerNames } from './stale-tab-report.ts';
import { findUnnamedAgents } from './unnamed-agent-report.ts';

interface AgentRowFields {
  readonly paneId: string;
  readonly name: string | null;
  readonly sessionId: string;
}

function herdrAgentRow({ paneId, name, sessionId }: AgentRowFields): Record<string, unknown> {
  return {
    agent: 'claude',
    agent_status: 'idle',
    agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: sessionId },
    cwd: `/work/${paneId}`,
    focused: false,
    name,
    pane_id: paneId,
    tab_id: `tab-${paneId}`,
    tab_label: null,
    terminal_id: `term-${paneId}`,
  };
}

function liveAgentsFromHerdr(rows: readonly AgentRowFields[]) {
  return parseHerdrAgentList(JSON.stringify({ result: { agents: rows.map(herdrAgentRow) } }));
}

function tab(paneId: string, label: string): HerdrTab {
  return { tabId: `tab-${paneId}`, label, paneCount: 1, workspaceId: 'w1' };
}

async function ledgerNamesOf(live: string[], reaped: string[]): Promise<Set<string>> {
  return collectThroneLedgerNames({
    listRegisteredAgents: async () => live,
    listReapedAgentNames: async () => reaped,
  });
}

test('a live agent whose herdr name is gone is reported with its pane, tab, tab label, cwd, harness and session id', async () => {
  const liveAgents = liveAgentsFromHerdr([{ paneId: 'w1:pA', name: null, sessionId: 'session-a' }]);
  const reports = findUnnamedAgents(liveAgents, [tab('w1:pA', 'some label')], await ledgerNamesOf([], []));
  assert.deepEqual(reports, [
    {
      paneId: 'w1:pA',
      tabId: 'tab-w1:pA',
      tabLabel: 'some label',
      cwd: '/work/w1:pA',
      harness: 'claude',
      agentSessionId: 'session-a',
    },
  ]);
});

test('a live agent whose herdr name is blank is reported as unnamed', async () => {
  const liveAgents = liveAgentsFromHerdr([
    { paneId: 'w1:pEmpty', name: '', sessionId: 'session-empty' },
    { paneId: 'w1:pSpaces', name: '   ', sessionId: 'session-spaces' },
  ]);
  const reports = findUnnamedAgents(liveAgents, [], await ledgerNamesOf([], []));
  assert.deepEqual(reports.map((report) => report.paneId), ['w1:pEmpty', 'w1:pSpaces']);
});

test('a named live agent is never reported as unnamed', async () => {
  const liveAgents = liveAgentsFromHerdr([{ paneId: 'w1:pN', name: 'shadow-named', sessionId: 'session-n' }]);
  const reports = findUnnamedAgents(liveAgents, [tab('w1:pN', 'shadow-named')], await ledgerNamesOf(['shadow-named'], []));
  assert.deepEqual(reports, []);
});

test('an unnamed agent whose tab label matches a ledger agent name names that agent as its likely owner', async () => {
  const liveAgents = liveAgentsFromHerdr([{ paneId: 'w1:pS', name: null, sessionId: 'session-s' }]);
  const reports = findUnnamedAgents(liveAgents, [tab('w1:pS', 'stager-fable')], await ledgerNamesOf(['stager-fable'], []));
  assert.equal(reports[0].likelyOwner, 'stager-fable');
});

test('an unnamed agent whose tab label matches a reaped ledger agent name names that agent as its likely owner', async () => {
  const liveAgents = liveAgentsFromHerdr([{ paneId: 'w1:pR', name: null, sessionId: 'session-r' }]);
  const reports = findUnnamedAgents(liveAgents, [tab('w1:pR', 'shadow-reaped')], await ledgerNamesOf([], ['shadow-reaped']));
  assert.equal(reports[0].likelyOwner, 'shadow-reaped');
});

test('an unnamed agent whose tab label matches no ledger agent has no likely owner', async () => {
  const liveAgents = liveAgentsFromHerdr([{ paneId: 'w1:pX', name: null, sessionId: 'session-x' }]);
  const ledgerNames = await ledgerNamesOf(['Stager-Fable', 'stager'], []);
  const reports = findUnnamedAgents(liveAgents, [tab('w1:pX', 'stager-fable')], ledgerNames);
  assert.equal(reports.length, 1);
  assert.equal('likelyOwner' in reports[0], false);
});

test('an unnamed Regent pane is reported like any other', async () => {
  const liveAgents = liveAgentsFromHerdr([{ paneId: 'w1:pReg', name: null, sessionId: 'session-reg' }]);
  const reports = findUnnamedAgents(liveAgents, [tab('w1:pReg', 'regent')], await ledgerNamesOf(['regent'], []));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].likelyOwner, 'regent');
});
