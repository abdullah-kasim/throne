import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NO, YES } from '../relevance-classifier/classifier.types.ts';
import {
  PREVIOUS_RECALL_LEDGER_FILE_NAME,
  RECALL_LEDGER_FILE_NAME,
  appendDecisionsToLedger,
  readServedFilePaths,
  recordServedFilePaths,
} from './recall-records.ts';
import type { MemoryDecision } from './select-memories.ts';

function decision(fileName: string, pick: string, probability: number, served: boolean): MemoryDecision {
  return {
    memory: { filePath: `/memories/${fileName}`, fileName, frontmatter: {}, body: 'lesson' },
    answer: { questionId: `/memories/${fileName}`, pick, probability, backend: 'rules', failedOpen: false },
    served,
  };
}

const NOW = new Date('2026-09-21T00:00:00Z');

test('a ledger over its size limit is set aside before the next decisions are written', async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), 'recall-records-'));
  await appendDecisionsToLedger(dataDirectory, 'first task', [decision('A.md', YES, 1, true)], NOW, 10);
  await appendDecisionsToLedger(dataDirectory, 'second task', [decision('B.md', YES, 1, true)], NOW, 10);
  assert.match(readFileSync(path.join(dataDirectory, PREVIOUS_RECALL_LEDGER_FILE_NAME), 'utf8'), /A\.md/);
  const current = readFileSync(path.join(dataDirectory, RECALL_LEDGER_FILE_NAME), 'utf8');
  assert.match(current, /B\.md/);
  assert.doesNotMatch(current, /A\.md/);
});

test('a confident no is counted in the summary line and gets no line of its own', async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), 'recall-records-'));
  await appendDecisionsToLedger(
    dataDirectory,
    'task',
    [decision('SERVED.md', YES, 0.9, true), decision('NEAR_MISS.md', NO, 0.67, false), decision('UNRELATED.md', NO, 1, false)],
    NOW,
  );
  const ledger = readFileSync(path.join(dataDirectory, RECALL_LEDGER_FILE_NAME), 'utf8');
  assert.match(ledger, /SERVED\.md/);
  assert.match(ledger, /NEAR_MISS\.md/);
  assert.doesNotMatch(ledger, /UNRELATED\.md/);
  assert.match(ledger, /"questionsAsked":3,"served":1,"confidentNoAnswersLeftOut":1/);
});

test('served lists older than the limit are removed when a list is recorded', async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), 'recall-records-'));
  await recordServedFilePaths(dataDirectory, 'old-session', new Set(['/memories/A.md']), NOW);
  const oldListPath = path.join(dataDirectory, 'served', 'old-session.json');
  const fortyDaysEarlier = new Date(NOW.getTime() - 40 * 86_400_000);
  utimesSync(oldListPath, fortyDaysEarlier, fortyDaysEarlier);
  await recordServedFilePaths(dataDirectory, 'new-session', new Set(['/memories/B.md']), NOW);
  assert.equal(existsSync(oldListPath), false);
  assert.deepEqual(readdirSync(path.join(dataDirectory, 'served')), ['new-session.json']);
  assert.deepEqual([...(await readServedFilePaths(dataDirectory, 'new-session'))], ['/memories/B.md']);
});
