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

const bodyRewrite = await import('../.claude/skills/pr-media/body-rewrite.mjs');

const SEQUENCE_HEADING = '### `## Sequence`';
const HOW_THEN_SEQUENCE_THEN_SCREENSHOTS =
  /\n### `## How`\n(?:(?!\n### )[\s\S])*\n### `## Sequence`\n(?:(?!\n### )[\s\S])*\n### `## Screenshots` \(UI changes only\)\n/;
const SEQUENCE_SECTION = [
  '## Sequence',
  '',
  '<details open>',
  '<summary>Sequence diagram</summary>',
  '',
  '```mermaid',
  'sequenceDiagram',
  '    participant Shopper',
  '    participant Basket as Basket service',
  '    Shopper->>Basket: addItem("teapot")',
  '    Basket-->>Shopper: 1 item',
  '```',
  '',
  '</details>',
].join('\n');
const SCREENSHOTS_DRAFT =
  '## Screenshots\n\nThe basket, with one item:\n\n<!-- pr-media: 01-basket.png -->\n![basket](./01-basket.png)\n<!-- /pr-media: 01-basket.png -->';

async function readSequenceSubsection(): Promise<string> {
  return unwrap(await readPullRequestBodySubsection(SEQUENCE_HEADING));
}

test("a pull request body shows the change's runtime flow in a Sequence section directly after How", async () => {
  assert.match(
    `\n${await readPullRequestBodySections()}`,
    HOW_THEN_SEQUENCE_THEN_SCREENSHOTS,
    'the Sequence subsection sits between the How and Screenshots subsections',
  );
  assert.deepEqual(
    missingPhrases(await readSequenceSubsection(), [
      'Directly after `## How` and before `## Screenshots`.',
      "a diagram of the change's runtime flow, so a reviewer sees who calls whom before reading the prose.",
    ]),
    [],
  );
});

test('the Sequence section sits in a spoiler titled Sequence diagram that starts open, so Forgejo sizes its diagrams, with its heading left visible', async () => {
  assert.deepEqual(
    missingPhrases(await readSequenceSubsection(), [
      "The section's content is wrapped in a collapsible spoiler that starts open: `<details open><summary>Sequence diagram</summary>`, a blank line, the diagram, a blank line, `</details>`.",
      'Inside a closed spoiler that height is 0, and opening the spoiler later does not measure it again',
      'The `## Sequence` heading itself stays outside the wrapper and unchanged.',
      'The other wrapping and blank-line rules are the ones the `## Agents` section states.',
    ]),
    [],
  );
});

test('the sequence diagram is a mermaid sequenceDiagram written from the code, with runtime participants, real call names, a before and an after for a changed flow, and a size limit', async () => {
  assert.deepEqual(
    missingPhrases(await readSequenceSubsection(), [
      'The diagram is a fenced `mermaid` code block holding a `sequenceDiagram`, written from the code and never from memory',
      '**Participants are the things that talk at runtime:** a browser, a route, a service, a store, another system. Never files.',
      '**Every arrow is a real call or message, labelled with its real name:**',
      '**A change to an existing flow gets two diagrams, before and after,**',
      '**At most about eight participants and twenty arrows.** Above that, split by scenario',
      '**No caption that restates the `## How` bullets.**',
    ]),
    [],
  );
});

test('a host that shows the raw code block gets the diagram as an image published through pr-media inside the same spoiler', async () => {
  assert.deepEqual(
    missingPhrases(await readSequenceSubsection(), [
      'On a host that shows the raw code block instead, render the diagram to an image for that host and publish it through `/pr-media`, inside the same spoiler',
      'PlantUML is the renderer for that image, used only when it is installed: `plantuml -tsvg`',
    ]),
    [],
  );
});

test('a change with no runtime flow between two participants has no Sequence section, no heading and no placeholder', async () => {
  assert.deepEqual(
    missingPhrases(await readSequenceSubsection(), [
      "**Leave the section out, with no heading and no placeholder,** when the change has no runtime flow between at least two participants: documentation, configuration, a rename, a pure refactor that changes no call, a single function's internals.",
    ]),
    [],
  );
});

test('the reference example carries an invented sequence diagram between How and Testing', async () => {
  const example = await readPullRequestReferenceExample();
  assert.match(
    example,
    /\n## How\n\n(?:- .+\n)+\n## Sequence\n\n<details open>\n<summary>Sequence diagram<\/summary>\n\n```mermaid\nsequenceDiagram\n(?: {4}participant .+\n){2,8}(?: {4}\w+--?>>\w+: .+\n){1,20}```\n\n<\/details>\n\n## Testing\n/,
  );
});

test('a body with a Sequence section still gets its media placed under Screenshots', () => {
  const beforeSequence = '## What\n\nwords\n\n## How\n\n- how\n\n';
  const testing = '## Testing\n\nsteps\n';
  const withScreenshots = `${beforeSequence}${SEQUENCE_SECTION}\n\n## Screenshots\n\nold text\n\n<!-- drop old.png here -->\n\n${testing}`;
  const withoutScreenshots = `${beforeSequence}${SEQUENCE_SECTION}\n\n${testing}`;
  const expected = `${beforeSequence}${SEQUENCE_SECTION}\n\n${SCREENSHOTS_DRAFT}\n\n${testing}`;
  assert.equal(bodyRewrite.replaceScreenshotsSection(withScreenshots, SCREENSHOTS_DRAFT), expected);
  assert.equal(bodyRewrite.replaceScreenshotsSection(withoutScreenshots, SCREENSHOTS_DRAFT), expected);
});

test('a diagram the skill shows has runtime participants and never a file path', async () => {
  const shownParticipants = (await readPullRequestDescriptionSkill())
    .split('\n')
    .flatMap((line) => /^\s+participant\s+(?:\S+\s+as\s+)?(.+)$/.exec(line)?.[1] ?? []);
  assert.notDeepEqual(shownParticipants, []);
  assert.deepEqual(
    shownParticipants.filter((participant) => /\/|\.\w+\b/.test(participant)),
    [],
  );
});
