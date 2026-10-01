import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NO, YES } from '../relevance-classifier/classifier.types.ts';
import { SERVE_ARM } from '../relevance-classifier/recall-user-config.ts';
import {
  COMMAND_SOURCE,
  HOOK_SOURCE,
  PREVIOUS_RECALL_LEDGER_FILE_NAME,
  RECALL_LEDGER_FILE_NAME,
  appendDecisionsToLedger,
  readWhenServedInSession,
  recordWhenServedInSession,
  type PromptJudgement,
} from './recall-records.ts';
import { verdictOf } from './recall-verdict.ts';
import type { MemoryDecision } from './select-memories.ts';

function decision(fileName: string, pick: string, probability: number, served: boolean): MemoryDecision {
  return {
    memory: { filePath: `/memories/${fileName}`, fileName, frontmatter: {}, body: 'lesson', fileText: 'lesson' },
    answer: { questionId: `/memories/${fileName}`, pick, probability, backend: 'rules', failedOpen: false },
    served,
    servedEarlierInSession: false,
  };
}

const NOW = new Date('2026-09-21T00:00:00Z');

function judgement(taskText: string, decisions: readonly MemoryDecision[]): PromptJudgement {
  return {
    taskText,
    decisions,
    decidedAt: NOW,
    source: COMMAND_SOURCE,
    sessionId: undefined,
    arm: SERVE_ARM,
    verdict: verdictOf(decisions),
    searchedMemoryDirectories: ['/memories'],
    whenServedInSession: new Map(),
  };
}

test('a ledger over its size limit is set aside before the next decisions are written', async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), 'recall-records-'));
  await appendDecisionsToLedger(dataDirectory, judgement('first task', [decision('A.md', YES, 1, true)]), 10);
  await appendDecisionsToLedger(dataDirectory, judgement('second task', [decision('B.md', YES, 1, true)]), 10);
  assert.match(readFileSync(path.join(dataDirectory, PREVIOUS_RECALL_LEDGER_FILE_NAME), 'utf8'), /A\.md/);
  const current = readFileSync(path.join(dataDirectory, RECALL_LEDGER_FILE_NAME), 'utf8');
  assert.match(current, /B\.md/);
  assert.doesNotMatch(current, /A\.md/);
});

test('in a serve-mode hook a confident no is counted in the summary line and gets no line of its own', async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), 'recall-records-'));
  await appendDecisionsToLedger(dataDirectory, {
    ...judgement('task', [decision('SERVED.md', YES, 0.9, true), decision('NEAR_MISS.md', NO, 0.67, false), decision('UNRELATED.md', NO, 1, false)]),
    source: HOOK_SOURCE,
    hookMode: SERVE_ARM,
  });
  const ledger = readFileSync(path.join(dataDirectory, RECALL_LEDGER_FILE_NAME), 'utf8');
  assert.match(ledger, /SERVED\.md/);
  assert.match(ledger, /NEAR_MISS\.md/);
  assert.doesNotMatch(ledger, /UNRELATED\.md/);
  assert.match(ledger, /"questionsAsked":3,"served":1,"confidentNoAnswersLeftOut":1/);
});

test('served lists older than the limit are removed when a list is recorded', async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), 'recall-records-'));
  await recordWhenServedInSession(dataDirectory, 'old-session', new Map([['/memories/A.md', NOW.toISOString()]]), NOW);
  const oldListPath = path.join(dataDirectory, 'served', 'old-session.json');
  const fortyDaysEarlier = new Date(NOW.getTime() - 40 * 86_400_000);
  utimesSync(oldListPath, fortyDaysEarlier, fortyDaysEarlier);
  await recordWhenServedInSession(dataDirectory, 'new-session', new Map([['/memories/B.md', NOW.toISOString()]]), NOW);
  assert.equal(existsSync(oldListPath), false);
  assert.deepEqual(readdirSync(path.join(dataDirectory, 'served')), ['new-session.json']);
  assert.deepEqual([...(await readWhenServedInSession(dataDirectory, 'new-session'))], [['/memories/B.md', NOW.toISOString()]]);
});

test('a served list written before serving times were kept is still read, with no time for each memory', async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), 'recall-records-'));
  mkdirSync(path.join(dataDirectory, 'served'));
  writeFileSync(path.join(dataDirectory, 'served', 'old-form.json'), JSON.stringify(['/memories/A.md']));
  assert.deepEqual([...(await readWhenServedInSession(dataDirectory, 'old-form'))], [['/memories/A.md', null]]);
});
