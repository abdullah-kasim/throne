import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildUnnamedAgentsMessage, type UnnamedAgentPane } from './message.ts';

const stagerPane: UnnamedAgentPane = {
  paneId: 'w1:pT',
  tabLabel: 'stager-fable',
  harness: 'claude',
  likelyOwner: 'stager-fable',
};

const strayPane: UnnamedAgentPane = {
  paneId: 'w2:p4',
  tabLabel: 'scratch',
  harness: 'codex',
};

const unlabelledPane: UnnamedAgentPane = {
  paneId: 'w3:p1',
  harness: 'claude',
};

test('the unnamed-agent notice lists every unnamed pane', () => {
  const message = buildUnnamedAgentsMessage({ unnamedAgents: [stagerPane, strayPane, unlabelledPane] });

  assert.match(message, /pane w1:pT \(tab label stager-fable, claude\)/);
  assert.match(message, /pane w2:p4 \(tab label scratch, codex\)/);
  assert.match(message, /pane w3:p1 \(no tab label, claude\)/);
  assert.match(message, /never renames a pane itself/);
});

test('the unnamed-agent notice gives the exact herdr rename command for a pane with a likely owner', () => {
  const message = buildUnnamedAgentsMessage({ unnamedAgents: [stagerPane] });

  assert.ok(
    message.includes('herdr agent rename w1:pT stager-fable'),
    `expected the exact rename command in: ${message}`,
  );
  assert.doesNotMatch(message, /owner unknown/);
});

test('the unnamed-agent notice tells the Regent to inspect a pane whose owner is unknown', () => {
  const message = buildUnnamedAgentsMessage({ unnamedAgents: [stagerPane, strayPane] });
  const strayItem = message.split('; ').find((item) => item.includes('pane w2:p4'));

  assert.ok(strayItem, `expected an item for pane w2:p4 in: ${message}`);
  assert.match(strayItem, /owner unknown, inspect the pane/);
  assert.doesNotMatch(strayItem, /herdr agent rename/);
});
