import assert from 'node:assert/strict';
import { test } from 'node:test';

import { missingPhrases, readMarkdownSection, readSkillSource, unwrap } from './skill-contract-test-helpers.ts';

async function readPublishStep(heading: string): Promise<string> {
  const step = unwrap(readMarkdownSection(await readSkillSource('publish'), heading));
  assert.notEqual(step, '', `publish has no "${heading}" step`);
  return step;
}

async function readSkillWriterExtensionStep(): Promise<string> {
  const heading = '## 3c. Operator-only steps of a throne skill go into its extension';
  const step = unwrap(readMarkdownSection(await readSkillSource('skill-writer'), heading));
  assert.notEqual(step, '', `skill-writer has no "${heading}" step`);
  return step;
}

function assertHolds(text: string, phrases: string[]): void {
  assert.deepEqual(missingPhrases(text, phrases), []);
}

test('the publish read decides for each finding whether the passage is general', async () => {
  assertHolds(await readPublishStep('### (b) Read the staged snapshot'), [
    'For each finding in a SKILL.md that is a passage rather than a stray word, decide whether the passage is general',
    '**A general rule with a private example or name:** keep the rule and replace the name with an invented one',
  ]);
});

test('the publish read moves a passage only this operator uses into that skill\'s extension', async () => {
  assertHolds(await readPublishStep('### (b) Read the staged snapshot'), [
    '**A step, tool, bot, reply format, host or habit that only this operator uses:** move it into the operator\'s extension for that skill',
    'running a company\'s own review command before a merge',
    'answering a named review bot in its own reply forms',
    'never deleted and never rewritten into something vaguer',
  ]);
  assertHolds(await readPublishStep('### (c) Fix at the private source'), [
    'Append the passage, word for word, to `<throne home>/skill-extensions/<skill>.md` under a heading naming where it came from',
    'create it with the same short preamble the existing extensions use',
    'run `throne skill-extension --list`, read one listed file',
    'the heading `# <skill> — this machine\'s additions`, a blank line, and the line `This file is private to this machine and is never committed.`',
    'AGENTS.md "Operator extensions to skills" and `agent_docs/skill-extensions.md`',
    'leave one general sentence in its place',
    'Show the moved text and the extension path in the publish report',
    'Re-run (a) and repeat the read in (b)',
  ]);
});

test('the publish read proves the extension prints a moved passage before cutting it', async () => {
  const step = await readPublishStep('### (c) Fix at the private source');
  assertHolds(step, [
    'Run `throne skill-extension <skill>` and check that it prints the passage',
    'Only then cut the passage from the skill',
  ]);
  assert.ok(
    step.indexOf('Append the passage') < step.indexOf('throne skill-extension <skill>'),
    'the passage is appended before the extension is printed',
  );
  assert.ok(
    step.indexOf('throne skill-extension <skill>') < step.indexOf('Only then cut the passage'),
    'the extension is printed before the passage is cut',
  );
});

test('the publish read generalises a court hard rule instead of moving it', async () => {
  assertHolds(await readPublishStep('### (b) Read the staged snapshot'), [
    '**A court hard rule, or a passage other skills depend on:** never moved',
    'Generalise it in place instead, and say in the publish report why it stayed',
  ]);
});

test('the publish skill shows the move with an invented bakery example', async () => {
  assertHolds(await readPublishStep('### (c) Fix at the private source'), [
    'A bakery\'s generic deploy skill has a step',
    'Only this bakery has `oven-check`, so the step moves',
    '`throne skill-extension deploy` prints it, and only then is it cut from the skill',
  ]);
});

test('the publish skill never deletes or blurs a passage only this operator uses', async () => {
  assertHolds(await readPublishStep('## What this skill never does'), [
    'Never deletes or blurs a passage only this operator uses',
    'Never moves an operator extension into `.claude/skills`',
  ]);
});

test('skill-writer puts an operator-only step of a throne skill straight into that skill\'s extension', async () => {
  assertHolds(await readSkillWriterExtensionStep(), [
    'put every step that only this operator uses straight into the operator\'s extension for that skill',
    'rather than into SKILL.md',
    'The test is the same one the publish skill applies in its step (b)',
    'a court hard rule, or a passage other skills depend on, stays in SKILL.md, generalised',
    'check that `throne skill-extension <skill>` prints the step',
    'Only throne skills have extensions',
  ]);
});

test('skill-writer shows the extension rule with an invented bakery example', async () => {
  assertHolds(await readSkillWriterExtensionStep(), [
    'Porting a bakery\'s generic deploy skill into this throne',
    'goes into `<throne home>/skill-extensions/deploy.md`, because only this bakery has `oven-check`',
  ]);
});
