import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NO, YES, yesOrNoQuestion } from './classifier.types.ts';
import { RULES_BACKEND, meaningfulWords } from './rules-backend.ts';

test('meaningful words drop common words, short words and plural endings', () => {
  assert.deepEqual(
    [...meaningfulWords('Does the task edit GitHub pull requests of a PR?')].sort(),
    ['edit', 'github', 'pull', 'request'],
  );
});

test('shared words raise the probability of yes until certainty', async () => {
  const question = (id: string, text: string) =>
    yesOrNoQuestion(id, 'unused by rules', { kind: 'shared-words', text, sharedWordsForCertainty: 3 });
  const answers = await RULES_BACKEND.answer('rewrite the github pull request description', [
    question('three', 'Does the task edit a GitHub pull request description?'),
    question('one', 'Does the task touch a github action?'),
    question('none', 'Does the task configure a wifi router?'),
  ]);
  assert.deepEqual(answers, [
    { questionId: 'three', pick: YES, probability: 1 },
    { questionId: 'one', pick: NO, probability: 1 - 1 / 3 },
    { questionId: 'none', pick: NO, probability: 1 },
  ]);
});

test('any phrase found in the state, in any letter case, answers yes', async () => {
  const question = yesOrNoQuestion('chunk', 'unused by rules', {
    kind: 'any-phrase',
    phrases: ['not ok', 'traceback', ''],
  });
  const [found] = await RULES_BACKEND.answer('12 passing\nNOT OK 3 - loads config', [question]);
  const [absent] = await RULES_BACKEND.answer('12 passing\nok 3 - loads config', [question]);
  assert.deepEqual(found, { questionId: 'chunk', pick: YES, probability: 1 });
  assert.deepEqual(absent, { questionId: 'chunk', pick: NO, probability: 1 });
});
