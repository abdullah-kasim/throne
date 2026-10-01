import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { NO, YES, type ClassifierBackend } from '../relevance-classifier/classifier.types.ts';
import type { RecallConfig } from '../relevance-classifier/recall-user-config.ts';
import { runRecall } from './recall.command.ts';
import {
  HOOK_PAYLOAD,
  IN_PROJECT,
  PULL_REQUEST_TASK,
  assertEveryAnswerWasLogged,
  harness,
  isCompactAnswerLine,
  ledgerEntries,
  ledgerLines,
} from './recall.command.test-support.ts';
import { readRecallReportLogs } from './recall-report-logs.ts';

async function hookRunIn(
  hookMode: RecallConfig['hookMode'],
  options: { backend?: ClassifierBackend } = {},
) {
  const fixture = harness({ hookEnabled: true, hookMode }, { ...options, stdin: HOOK_PAYLOAD });
  await runRecall(['--hook'], fixture.dependencies);
  return fixture;
}

test('while the hook runs in split mode every answer is logged, a confident no as a compact line', async () => {
  const fixture = await hookRunIn('split');
  assertEveryAnswerWasLogged(fixture.dataDirectory);
});

test('while the hook runs in shadow mode every answer is logged', async () => {
  const fixture = await hookRunIn('shadow');
  assertEveryAnswerWasLogged(fixture.dataDirectory);
});

test('a hand recall logs every answer, including confident noes', async () => {
  const fixture = harness();
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], fixture.dependencies);
  assertEveryAnswerWasLogged(fixture.dataDirectory);
});

test('a serve-mode hook still only counts confident noes', async () => {
  const fixture = await hookRunIn('serve');
  const [summary] = ledgerLines(fixture.dataDirectory).filter((line) => 'questionsAsked' in line);
  assert.equal('everyAnswerLogged' in (summary ?? {}), false);
  assert.equal(summary?.confidentNoAnswersLeftOut, 1);
  assert.deepEqual(
    ledgerEntries(fixture.dataDirectory).map((line) => path.basename(String(line.questionId))),
    ['NEVER_REPUBLISH.md'],
  );
});

test('a prompt whose surest answer is a confident no is still counted against the backend that answered it', async () => {
  const noForTheWifiMemoryOnly: ClassifierBackend = {
    name: 'jev',
    answer: async (_state, questions) =>
      questions.map((question) =>
        question.id.endsWith('NETWORK_SAFETY.md')
          ? { questionId: question.id, pick: NO, probability: 1 }
          : { questionId: question.id, pick: YES, probability: 0.8 },
      ),
  };
  const fixture = await hookRunIn('split', { backend: noForTheWifiMemoryOnly });
  assert.equal(isCompactAnswerLine(ledgerEntries(fixture.dataDirectory)[0] ?? {}), true);
  const { prompts } = await readRecallReportLogs(fixture.dataDirectory, undefined);
  assert.deepEqual(prompts.map((prompt) => prompt.recallBackend), ['jev']);
});
