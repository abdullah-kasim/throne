import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeScratchDirectory } from '../scratch-directory.test-support.ts';
import { JEV_BUDGET_LOCK_STALE_AFTER_MILLISECONDS, readJevSpend } from './jev-budget.ts';
import { killWithoutCleanup, startProcessHoldingTheJevBudgetLock } from './jev-budget.test-support.ts';
import {
  letSpendingProcessesGoAndFinish,
  startSpendingProcess,
  startSpendingProcesses,
  type SpendingProcessOrder,
} from './jev-budget-processes.test-support.ts';
import { FIRST_CONTENDER, LATE_CONTENDER } from './jev-budget-pinned-file-system.test-support.ts';
import { readJevUsageLines, type JevUsageLine, type JevUsageLog } from './jev-usage-log.ts';

const PROCESS_COUNT = 4;
const MARGIN_PAST_STALE_MILLISECONDS = 200;

function scratchDataHome(): Promise<string> {
  return makeScratchDirectory('jev-budget-processes-');
}

function answeredTokens(lines: readonly JevUsageLine[]): number {
  return lines
    .filter((line) => line.outcome === 'answered')
    .reduce((total, line) => total + line.estimatedTokens, 0);
}

test('four processes spending concurrently through Jev never reserve more than the day limit and every usage line they wrote parses', async () => {
  const dataHome = await scratchDataHome();
  const order = { dataHome, goFile: path.join(dataHome, 'go'), tokensPerDay: 300, requests: 10 };
  const children = await startSpendingProcesses(PROCESS_COUNT, order);
  await letSpendingProcessesGoAndFinish(children, order.goFile);
  const usage = await readJevUsageLines(dataHome);
  assert.equal(usage.unreadableLineCount, 0);
  assert.equal(usage.lines.length, PROCESS_COUNT * order.requests);
  assert.ok(usage.lines.some((line) => line.outcome === 'rate-limited'));
  assert.ok(answeredTokens(usage.lines) <= order.tokensPerDay);
  assert.ok((await readJevSpend(dataHome, new Date())).todayTokens <= order.tokensPerDay);
});

async function spendingAfterALockHolderWasKilled(
  startContenders: (order: SpendingProcessOrder) => Promise<readonly ChildProcess[]>,
): Promise<{ readonly order: SpendingProcessOrder; readonly usage: JevUsageLog }> {
  const dataHome = await scratchDataHome();
  const holder = await startProcessHoldingTheJevBudgetLock(dataHome);
  await killWithoutCleanup(holder.child);
  const order = { dataHome, goFile: path.join(dataHome, 'go'), tokensPerDay: 30, requests: 1 };
  const children = await startContenders(order);
  const stillFresh = holder.heldAt + JEV_BUDGET_LOCK_STALE_AFTER_MILLISECONDS + MARGIN_PAST_STALE_MILLISECONDS - Date.now();
  await sleep(Math.max(0, stillFresh));
  await letSpendingProcessesGoAndFinish(children, order.goFile);
  return { order, usage: await readJevUsageLines(dataHome) };
}

test('four processes racing to take over a budget lock left by a killed process never overspend the day limit', async () => {
  const { order, usage } = await spendingAfterALockHolderWasKilled((order) => startSpendingProcesses(PROCESS_COUNT, order));
  assert.equal(usage.unreadableLineCount, 0);
  assert.equal(usage.lines.filter((line) => line.outcome === 'answered').length, 1);
  assert.ok(answeredTokens(usage.lines) <= order.tokensPerDay);
  assert.ok((await readJevSpend(order.dataHome, new Date())).todayTokens <= order.tokensPerDay);
});

test('a contender that saw the killed holder\'s stale lock never takes over the lock a rival already took over', async () => {
  const pinnedTakeover = path.join(import.meta.dirname, 'jev-budget-pinned-takeover.test-support.ts');
  const { usage } = await spendingAfterALockHolderWasKilled((order) =>
    Promise.all(
      [FIRST_CONTENDER, LATE_CONTENDER].map((contender) =>
        startSpendingProcess({ ...order, contender } as typeof order, pinnedTakeover),
      ),
    ),
  );
  assert.deepEqual(
    usage.lines.map((line) => line.outcome).sort(),
    ['answered', 'rate-limited'],
  );
});
