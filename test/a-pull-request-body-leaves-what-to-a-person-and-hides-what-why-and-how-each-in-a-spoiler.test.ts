import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  missingPhrases,
  readPullRequestBodySections,
  readPullRequestBodySubsection,
  readPullRequestDescriptionSkill,
  readPullRequestReferenceExample,
  unwrap,
} from './skill-contract-test-helpers.ts';

const HUMAN_WHAT_HEADING = '### `## What (human)`';
const SPOILER_HEADING = '### What, Why and How each sit in a closed spoiler';

test('a pull request body opens with a What (human) section that only a person fills', async () => {
  const body = await readPullRequestBodySections();
  assert.ok(body.indexOf(HUMAN_WHAT_HEADING) !== -1, 'pr-description has no What (human) subsection');
  assert.ok(body.indexOf(HUMAN_WHAT_HEADING) < body.indexOf('### `## What`\n'), 'What (human) comes before What');
  assert.deepEqual(
    missingPhrases(unwrap(await readPullRequestBodySubsection(HUMAN_WHAT_HEADING)), [
      'The first section of every body, left for a person to write what the pull request does in their own words.',
      'Human text goes here.',
      'Never fill the section, never summarise your own `## What` into it, and never leave it out.',
      'keep whatever a person wrote here word for word.',
    ]),
    [],
  );
});

test('What, Why and How each keep a visible heading over their own closed spoiler', async () => {
  const body = await readPullRequestBodySections();
  assert.ok(body.indexOf(SPOILER_HEADING) < body.indexOf('### `## What`\n'), 'the spoiler rule comes before What');
  assert.deepEqual(
    missingPhrases(unwrap(await readPullRequestBodySubsection(SPOILER_HEADING)), [
      'Each keeps its heading visible, outside its own spoiler, and wraps only its content in a collapsible spoiler hidden by default',
      '`<details><summary>What</summary>`',
      'Never put the three in one shared spoiler, and never put a heading inside a spoiler.',
      'Both blank lines are mandatory',
    ]),
    [],
  );
  const skill = await readPullRequestDescriptionSkill();
  assert.ok(!skill.includes('are never collapsed'), 'a rule still says What, Why and How are never collapsed');
  assert.ok(!skill.includes('<summary>What, Why, How</summary>'), 'the skill still shows one shared spoiler');
});

test('the reference example leaves What (human) to a person and gives What, Why and How a spoiler each', async () => {
  const example = (await readPullRequestReferenceExample()).trimStart();
  assert.match(
    example,
    /^````markdown\nTicket: .+\n\n## What \(human\)\n\nHuman text goes here\.\n\n## What\n\n<details>\n<summary>What<\/summary>\n\n.+\n\n<\/details>\n\n## Why\n\n<details>\n<summary>Why<\/summary>\n\n.+\n\n<\/details>\n\n## How\n\n<details>\n<summary>How<\/summary>\n\n(?:- .+\n)+\n<\/details>\n\n## Sequence\n/,
  );
});
