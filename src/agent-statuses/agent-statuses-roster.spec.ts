import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { readHarnessBackgroundWork } from '../process-inspection/harness-background-work.ts';
import {
  harnessProcessHost,
  processTableCapture,
  PROCESS_HOST_WITHOUT_HERDR,
} from '../process-inspection/harness-background-work-test-fixtures.ts';
import type { LiveAgentStatus } from './agent-statuses-herdr.ts';
import { getAgentStatusesRoster } from './agent-statuses-roster.ts';

const WORKTREE = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-statuses-roster-')));
const HOLD_SCRIPT_HOST = harnessProcessHost({
  processTable: await processTableCapture('macos-claude-harness-with-background-hold-script'),
  harnessDirectory: WORKTREE,
});
const IDLE_HOST = harnessProcessHost({
  processTable: await processTableCapture('macos-claude-idle-harness'),
  harnessDirectory: WORKTREE,
});

function idlePane(name: string): LiveAgentStatus {
  return {
    agent: 'claude',
    name,
    agentStatus: 'idle',
    cwd: WORKTREE,
    focused: false,
    paneId: `pane-${name}`,
    tabId: `tab-${name}`,
    terminalId: `term-${name}`,
  };
}

async function liveStatusesWhenEachPaneRunsOn(
  hostOfPane: Record<string, Parameters<typeof readHarnessBackgroundWork>[1]>,
): Promise<Record<string, string | undefined>> {
  const roster = await getAgentStatusesRoster({
    listLiveAgentStatuses: async () => Object.keys(hostOfPane).map(idlePane),
    listRegisteredAgentNames: async () => [],
    listCompletedAgentNames: async () => [],
    readAgentStatusRole: async () => 'Shadow',
    loadAgentStatusesRegentTitle: async () => 'Regent',
    readHarnessBackgroundWork: (paneId) => readHarnessBackgroundWork(paneId, hostOfPane[paneId.replace('pane-', '')]),
  });
  return Object.fromEntries(roster.map((entry) => [entry.name, entry.liveStatus]));
}

test('agent-statuses shows an agent with live background work as working', async () => {
  assert.deepEqual(
    await liveStatusesWhenEachPaneRunsOn({
      'shadow-bakery-01-oven': HOLD_SCRIPT_HOST,
      'shadow-bakery-02-photos': IDLE_HOST,
      'shadow-bakery-03-recipes': PROCESS_HOST_WITHOUT_HERDR,
    }),
    {
      'shadow-bakery-01-oven': 'working',
      'shadow-bakery-02-photos': 'idle',
      'shadow-bakery-03-recipes': 'idle',
    },
  );
});
