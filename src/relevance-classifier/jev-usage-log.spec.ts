import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { makeScratchDirectory } from '../scratch-directory.test-support.ts';
import {
  appendJevUsageLine,
  jevUsageLogPath,
  readJevUsageLines,
  type JevUsageLine,
} from './jev-usage-log.ts';

function scratchDataHome(): Promise<string> {
  return makeScratchDirectory('jev-usage-');
}

function usageLine(index: number): JevUsageLine {
  return {
    at: new Date(2026, 8, 29, 12, 0, index).toISOString(),
    caller: 'hook',
    estimatedTokens: 1000 + index,
    realTokens: index % 2 === 0 ? null : 900 + index,
    outcome: index % 3 === 0 ? 'rate-limited' : 'answered',
  };
}

test('each usage line is appended whole and parses back', async () => {
  const dataHome = await scratchDataHome();
  const written = Array.from({ length: 200 }, (_, index) => usageLine(index));
  await Promise.all(written.map((line) => appendJevUsageLine(dataHome, line)));
  const text = await readFile(jevUsageLogPath(dataHome), 'utf8');
  assert.equal(text.split('\n').length, written.length + 1);
  const log = await readJevUsageLines(dataHome);
  assert.equal(log.unreadableLineCount, 0);
  const byTime = (left: JevUsageLine, right: JevUsageLine): number => left.at.localeCompare(right.at);
  assert.deepEqual([...log.lines].sort(byTime), written);
});

test('an unreadable usage line is counted rather than dropped without trace', async () => {
  const dataHome = await scratchDataHome();
  await appendJevUsageLine(dataHome, usageLine(1));
  await appendFile(jevUsageLogPath(dataHome), '{"at": "torn\n{"caller": "nobody"}\n');
  await appendJevUsageLine(dataHome, usageLine(2));
  const log = await readJevUsageLines(dataHome);
  assert.deepEqual(log.lines, [usageLine(1), usageLine(2)]);
  assert.equal(log.unreadableLineCount, 2);
});

test('usage lines can be read from a given moment onwards', async () => {
  const dataHome = await scratchDataHome();
  for (const index of [1, 2, 3]) await appendJevUsageLine(dataHome, usageLine(index));
  const since = new Date(usageLine(2).at);
  assert.deepEqual((await readJevUsageLines(dataHome, since)).lines, [usageLine(2), usageLine(3)]);
});

test('a missing usage log reads as no lines', async () => {
  assert.deepEqual(await readJevUsageLines(await scratchDataHome()), { lines: [], unreadableLineCount: 0 });
});
