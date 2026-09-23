import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildBlockedAgentPagingMessage,
  buildMcqTakeOverPagingMessage,
  REGENT_PROMPT_SAFETY_SENTENCE,
} from './blocked-agent-paging-message.ts';
import type { DetectedInteractivePrompt } from '../pane-prompts/detect-interactive-prompt.ts';

const PROMPT: DetectedInteractivePrompt = {
  harness: 'claude',
  kind: 'permission',
  question: 'Do you want to proceed?',
  command: 'rm -rf /private/tmp/dbgrepo',
  warnings: ['Dangerous rm operation on working directory or its ancestor: /private/tmp/dbgrepo'],
  options: [
    { number: 1, label: 'Yes' },
    { number: 2, label: 'No' },
  ],
  selectedNumber: 1,
  hint: 'Esc to cancel · Tab to amend',
};

test('a blocked pane with no prompt keeps the existing stuck message', () => {
  const message = buildBlockedAgentPagingMessage({
    agentName: 'shadow-x',
    paneId: 'w1:p1',
    title: null,
    stateLabels: {},
  });
  assert.equal(
    message,
    'shadow-x is blocked and is not a supervising Alpha with a live child (pane: w1:p1). ' +
      'It is stuck, not merely waiting on a child -- inspect it and answer for it directly.',
  );
});

test('a blocked pane with a detected prompt carries the kind, question, command, warning, options with the selected one marked, both clearing commands, and the safety sentence', () => {
  const message = buildBlockedAgentPagingMessage({
    agentName: 'shadow-x',
    paneId: 'w1:p1',
    cwd: '/tmp/tree',
    title: null,
    stateLabels: {},
    prompt: PROMPT,
  });
  assert.match(message, /^shadow-x is held up by an interactive prompt in its pane/u);
  assert.match(message, /pane: w1:p1; worktree: \/tmp\/tree/u);
  assert.match(message, /Prompt \(claude permission\): Do you want to proceed\?/u);
  assert.match(message, /Command:\nrm -rf \/private\/tmp\/dbgrepo/u);
  assert.match(message, /Warning: Dangerous rm operation/u);
  assert.match(message, /Options \(option 1 is selected\):\n❯ 1\. Yes\n {2}2\. No/u);
  assert.match(message, /throne mcq --agent shadow-x --answer <n> {2}or {2}throne mcq --agent shadow-x --dismiss/u);
  assert.ok(message.endsWith(REGENT_PROMPT_SAFETY_SENTENCE));
});

test('a question prompt without a command omits the command block', () => {
  const message = buildBlockedAgentPagingMessage({
    agentName: 'shadow-x',
    paneId: 'w1:p1',
    title: null,
    stateLabels: {},
    prompt: { ...PROMPT, kind: 'question', command: undefined, warnings: [], selectedNumber: null },
  });
  assert.doesNotMatch(message, /Command:/u);
  assert.doesNotMatch(message, /Warning:/u);
  assert.match(message, /Options \(no option is selected\)/u);
});

test('the take-over page names the caller, the agent, the reason, and tells the Regent to press the keys by hand', () => {
  const message = buildMcqTakeOverPagingMessage({
    agentName: 'shadow-x',
    paneId: 'w1:p1',
    caller: 'stager-a',
    reason: 'expected the cursor on row 2 after one Down press, observed row 1.',
  });
  assert.equal(
    message,
    'stager-a ran throne mcq for shadow-x (pane: w1:p1) and stopped pressing keys: ' +
      'expected the cursor on row 2 after one Down press, observed row 1. Regent, take over: press the keys by hand.',
  );
});
