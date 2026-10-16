import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  missingPhrases,
  readPullRequestBodySubsection,
  readSkill,
  unwrap,
} from './skill-contract-test-helpers.ts';

test('a media pair compares the base branch with the head in every round, never a pull request branch, stacked or not', async () => {
  assert.deepEqual(
    missingPhrases(unwrap(await readSkill('pr-media')), [
      "**The before is always the repository's default branch, never a pull request branch.**",
      'A stacked PR is no exception: its before is the default branch too, never the parent PR\'s branch it is based on',
      'a review fix, a feedback round or a rebuild of the media still pairs the default branch with the new head, and every pair in the body uses the same before.',
      "When a reviewer asks what changed since they looked, answer in a reply or in the caption's words, never by moving a pair's before off the default branch.",
      'A queue row or a brief that names any other before is wrong; follow this rule and say so in the report.',
    ]),
    [],
  );
});

test('the Screenshots section of a pull request body points every before at the default branch', async () => {
  assert.deepEqual(
    missingPhrases(unwrap(await readPullRequestBodySubsection('### `## Screenshots` (UI changes only)')), [
      "Every pair's before is the repository's default branch (`trunk`, `main`), in every round and for a stacked PR too, never a pull request branch",
    ]),
    [],
  );
});
