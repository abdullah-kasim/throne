import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  detectInteractivePrompt,
  INTERACTIVE_PROMPT_KINDS,
  offersOptionNumber,
  selectedOptionOf,
} from './detect-interactive-prompt.ts';

function fixture(name: string): Promise<string> {
  return readFile(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
}

test('fixture one: the live Claude Code permission prompt of 2026-09-22 yields a permission prompt with the quoted command, its warning, both options and the selected row', async () => {
  const prompt = detectInteractivePrompt(await fixture('claude-permission-prompt-dangerous-rm.txt'));
  assert.ok(prompt);
  assert.equal(prompt.harness, 'claude');
  assert.equal(prompt.kind, INTERACTIVE_PROMPT_KINDS.PERMISSION);
  assert.equal(prompt.question, 'Do you want to proceed?');
  assert.equal(
    prompt.command,
    "rm -rf /private/tmp/dbgrepo; cd /Users/theuser/.throne/worktrees/throne/shadow-locate-01-gather && node --test\n" +
      "--test-name-pattern='.*' src/file-locate/gather-candidates.test.ts 2>&1 | tail -60",
  );
  assert.deepEqual(prompt.warnings, [
    'Dangerous rm operation on working directory or its ancestor: /private/tmp/dbgrepo',
  ]);
  assert.deepEqual(prompt.options, [
    { number: 1, label: 'Yes' },
    { number: 2, label: 'No' },
  ]);
  assert.equal(prompt.selectedNumber, 1);
  assert.deepEqual(selectedOptionOf(prompt), { number: 1, label: 'Yes' });
  assert.equal(prompt.hint, 'Esc to cancel · Tab to amend');
  assert.equal(offersOptionNumber(prompt, 2), true);
  assert.equal(offersOptionNumber(prompt, 3), false);
});

test('fixture two: an AskUserQuestion menu yields a question prompt whose option descriptions are not options and whose selected row is the cursor row', async () => {
  const prompt = detectInteractivePrompt(await fixture('claude-ask-user-question-menu.txt'));
  assert.ok(prompt);
  assert.equal(prompt.kind, INTERACTIVE_PROMPT_KINDS.QUESTION);
  assert.equal(prompt.question, 'Which date library should the report use?');
  assert.equal(prompt.command, undefined);
  assert.deepEqual(prompt.warnings, []);
  assert.deepEqual(prompt.options, [
    { number: 1, label: 'date-fns (Recommended)' },
    { number: 2, label: 'dayjs' },
    { number: 3, label: 'Type something.' },
  ]);
  assert.equal(prompt.selectedNumber, 1);
  assert.equal(prompt.hint, 'Enter to select · ↑/↓ to navigate · Esc to cancel');
});

test('fixture three: a Codex frame with a numbered list in ordinary output yields nothing (the Codex seam is empty)', async () => {
  assert.equal(detectInteractivePrompt(await fixture('codex-idle-composer.txt')), undefined);
});

test('fixture four: a live permission prompt whose one-line command is drawn bare under the box title captures the box body as the command and all four options', async () => {
  const prompt = detectInteractivePrompt(await fixture('claude-permission-prompt-bare-command.txt'));
  assert.ok(prompt);
  assert.equal(prompt.kind, INTERACTIVE_PROMPT_KINDS.PERMISSION);
  assert.equal(prompt.command, 'touch ~/tmp/mcq-proof-one.txt\nCreate empty proof file in home tmp');
  assert.deepEqual(prompt.warnings, []);
  assert.equal(prompt.options.length, 4);
  assert.deepEqual(prompt.options[3], { number: 4, label: 'No' });
  assert.equal(prompt.selectedNumber, 1);
});

test('fixture five: once the cursor has left row 1 the hint shrinks to "Esc to cancel" and the prompt is still detected with the cursor on row 2', async () => {
  const prompt = detectInteractivePrompt(await fixture('claude-permission-prompt-cursor-moved.txt'));
  assert.ok(prompt);
  assert.equal(prompt.kind, INTERACTIVE_PROMPT_KINDS.PERMISSION);
  assert.equal(prompt.selectedNumber, 2);
  assert.equal(prompt.hint, 'Esc to cancel');
  assert.equal(prompt.options.length, 4);
});

test('a Claude frame with the permission hint but no option rows yields nothing', () => {
  assert.equal(detectInteractivePrompt('Do you want to proceed?\n\n Esc to cancel · Tab to amend\n'), undefined);
});

test('the cursor on the second row is reported as the selected number', () => {
  const prompt = detectInteractivePrompt(
    ' Do you want to proceed?\n   1. Yes\n ❯ 2. No\n\n Esc to cancel · Tab to amend\n',
  );
  assert.ok(prompt);
  assert.equal(prompt.selectedNumber, 2);
});

test('no cursor on any row reports a null selected number', () => {
  const prompt = detectInteractivePrompt(
    ' Do you want to proceed?\n   1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n',
  );
  assert.ok(prompt);
  assert.equal(prompt.selectedNumber, null);
});
