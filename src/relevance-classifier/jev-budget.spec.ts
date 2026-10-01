import assert from 'node:assert/strict';
import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeScratchDirectory } from '../scratch-directory.test-support.ts';
import { acquireAtomicMkdirLock } from '../alpha-monitoring/atomic-mkdir-lock.ts';
import {
  JEV_BUDGET_GRANTED,
  JEV_BUDGET_LOCK_BUSY,
  JEV_BUDGET_LOCK_STALE_AFTER_MILLISECONDS,
  JEV_BUDGET_OUTDATED_BUILD,
  JEV_BUDGET_REFUSED,
  JEV_BUDGET_SETTLED,
  JEV_TOKENS_PER_DAY_LIMIT,
  JEV_TOKENS_PER_HOUR_LIMIT,
  jevBudgetDirectory,
  jevBudgetLockPath,
  jevBudgetTallyPath,
  readJevSpend,
  reserveJevTokens,
  settleJevReservation,
  type JevReservation,
} from './jev-budget.ts';
import { killWithoutCleanup, startProcessHoldingTheJevBudgetLock } from './jev-budget.test-support.ts';
import { JEV_LIMITER_VERSION, type JevLimiterBuild } from './jev-limiter-build.ts';
import { jevUsageLogPath } from './jev-usage-log.ts';

const LIMITS = { tokensPerDay: 1000, tokensPerHour: 400 };
const NOON = new Date(2026, 8, 29, 12, 0);
const MINUTES = 60_000;
const A_WORKTREE_BUILD: JevLimiterBuild = { limiterVersion: JEV_LIMITER_VERSION, runsFromTheLiveCheckout: false };
const THE_LIVE_BUILD: JevLimiterBuild = { limiterVersion: JEV_LIMITER_VERSION, runsFromTheLiveCheckout: true };
const A_NEWER_WORKTREE_BUILD: JevLimiterBuild = { limiterVersion: JEV_LIMITER_VERSION + 1, runsFromTheLiveCheckout: false };
const A_NEWER_LIVE_BUILD: JevLimiterBuild = { limiterVersion: JEV_LIMITER_VERSION + 1, runsFromTheLiveCheckout: true };

function scratchDataHome(): Promise<string> {
  return makeScratchDirectory('jev-budget-');
}

function minutesAfter(moment: Date, minutes: number): Date {
  return new Date(moment.getTime() + minutes * MINUTES);
}

function grantedIds(reservation: JevReservation): readonly string[] {
  assert.equal(reservation.outcome, JEV_BUDGET_GRANTED);
  return reservation.reservationIds;
}

test('a batch that fits both limits is reserved and counted against today and this hour', async () => {
  const dataHome = await scratchDataHome();
  const reservation = await reserveJevTokens(dataHome, LIMITS, [100, 150], NOON, A_WORKTREE_BUILD);
  assert.equal(grantedIds(reservation).length, 2);
  assert.deepEqual(await readJevSpend(dataHome, NOON), { todayTokens: 250, lastHourTokens: 250 });
});

test('a batch that would cross the day limit is refused and nothing of it is recorded', async () => {
  const dataHome = await scratchDataHome();
  const limits = { tokensPerDay: 500, tokensPerHour: 400 };
  grantedIds(await reserveJevTokens(dataHome, limits, [300], NOON, A_WORKTREE_BUILD));
  const twoHoursLater = minutesAfter(NOON, 120);
  const refused = await reserveJevTokens(dataHome, limits, [100, 150], twoHoursLater, A_WORKTREE_BUILD);
  assert.deepEqual(refused, {
    outcome: JEV_BUDGET_REFUSED,
    limit: JEV_TOKENS_PER_DAY_LIMIT,
    spentTokens: 300,
    limitTokens: 500,
  });
  assert.deepEqual(await readJevSpend(dataHome, twoHoursLater), { todayTokens: 300, lastHourTokens: 0 });
});

test('a batch that would cross the rolling hour limit is refused while the day still has room', async () => {
  const dataHome = await scratchDataHome();
  grantedIds(await reserveJevTokens(dataHome, LIMITS, [300], NOON, A_WORKTREE_BUILD));
  const refused = await reserveJevTokens(dataHome, LIMITS, [150], minutesAfter(NOON, 30), A_WORKTREE_BUILD);
  assert.deepEqual(refused, {
    outcome: JEV_BUDGET_REFUSED,
    limit: JEV_TOKENS_PER_HOUR_LIMIT,
    spentTokens: 300,
    limitTokens: 400,
  });
  assert.deepEqual(await readJevSpend(dataHome, minutesAfter(NOON, 30)), { todayTokens: 300, lastHourTokens: 300 });
});

test('tokens reserved more than an hour ago no longer count against the hour limit', async () => {
  const dataHome = await scratchDataHome();
  grantedIds(await reserveJevTokens(dataHome, LIMITS, [300], NOON, A_WORKTREE_BUILD));
  const anHourLater = minutesAfter(NOON, 60);
  assert.equal(grantedIds(await reserveJevTokens(dataHome, LIMITS, [350], anHourLater, A_WORKTREE_BUILD)).length, 1);
  assert.deepEqual(await readJevSpend(dataHome, anHourLater), { todayTokens: 650, lastHourTokens: 350 });
});

test('the day count starts again at the local midnight', async () => {
  const dataHome = await scratchDataHome();
  const beforeMidnight = new Date(2026, 8, 29, 23, 50);
  const afterMidnight = new Date(2026, 8, 30, 0, 10);
  grantedIds(await reserveJevTokens(dataHome, { tokensPerDay: 300, tokensPerHour: 1000 }, [300], beforeMidnight, A_WORKTREE_BUILD));
  assert.deepEqual(await readJevSpend(dataHome, afterMidnight), { todayTokens: 0, lastHourTokens: 300 });
  grantedIds(await reserveJevTokens(dataHome, { tokensPerDay: 300, tokensPerHour: 1000 }, [200], afterMidnight, A_WORKTREE_BUILD));
  assert.deepEqual(await readJevSpend(dataHome, afterMidnight), { todayTokens: 200, lastHourTokens: 500 });
});

test('the real token count replaces the estimate when the response reports it', async () => {
  const dataHome = await scratchDataHome();
  const [first, second] = grantedIds(await reserveJevTokens(dataHome, LIMITS, [100, 150], NOON, A_WORKTREE_BUILD));
  assert.equal(await settleJevReservation(dataHome, first!, 40, NOON), JEV_BUDGET_SETTLED);
  assert.equal(await settleJevReservation(dataHome, second!, 200, NOON), JEV_BUDGET_SETTLED);
  assert.deepEqual(await readJevSpend(dataHome, NOON), { todayTokens: 240, lastHourTokens: 240 });
});

test('the estimate stays counted when no real token count is known', async () => {
  const dataHome = await scratchDataHome();
  const [only] = grantedIds(await reserveJevTokens(dataHome, LIMITS, [120], NOON, A_WORKTREE_BUILD));
  assert.equal(await settleJevReservation(dataHome, only!, undefined, NOON), JEV_BUDGET_SETTLED);
  assert.deepEqual(await readJevSpend(dataHome, NOON), { todayTokens: 120, lastHourTokens: 120 });
});

test('the budget tally is its own file and does not depend on the usage log', async () => {
  const dataHome = await scratchDataHome();
  grantedIds(await reserveJevTokens(dataHome, LIMITS, [300], NOON, A_WORKTREE_BUILD));
  await writeFile(jevUsageLogPath(dataHome), 'not a usage line\n');
  const refused = await reserveJevTokens(dataHome, LIMITS, [200], NOON, A_WORKTREE_BUILD);
  assert.equal(refused.outcome, JEV_BUDGET_REFUSED);
  await rm(jevUsageLogPath(dataHome));
  assert.deepEqual(await readJevSpend(dataHome, NOON), { todayTokens: 300, lastHourTokens: 300 });
  assert.equal(path.dirname(jevBudgetTallyPath(dataHome)), jevBudgetDirectory(dataHome));
});

test('a reader without the lock never sees a torn budget tally', async () => {
  const dataHome = await scratchDataHome();
  const limits = { tokensPerDay: 10_000_000, tokensPerHour: 10_000_000 };
  grantedIds(await reserveJevTokens(dataHome, limits, [1], NOON, A_WORKTREE_BUILD));
  let writing = true;
  const reserveRepeatedly = async (): Promise<void> => {
    for (let round = 0; round < 25; round += 1) {
      grantedIds(await reserveJevTokens(dataHome, limits, Array.from({ length: 20 }, () => 1), NOON, A_WORKTREE_BUILD));
    }
  };
  const reserveFromFourWritersThenStop = async (): Promise<void> => {
    try {
      await Promise.all(Array.from({ length: 4 }, reserveRepeatedly));
    } finally {
      writing = false;
    }
  };
  const writers = reserveFromFourWritersThenStop();
  let reads = 0;
  while (writing) {
    const spend = await readJevSpend(dataHome, NOON);
    assert.equal(spend.todayTokens, spend.lastHourTokens);
    reads += 1;
  }
  await writers;
  assert.ok(reads > 0);
  assert.deepEqual(await readJevSpend(dataHome, NOON), { todayTokens: 2001, lastHourTokens: 2001 });
  assert.deepEqual(
    (await readdir(jevBudgetDirectory(dataHome))).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('a budget lock left by a killed process is taken over after the stale bound', async () => {
  const dataHome = await scratchDataHome();
  const holder = await startProcessHoldingTheJevBudgetLock(dataHome);
  await killWithoutCleanup(holder.child);
  const beforeTheStaleBound = await reserveJevTokens(dataHome, LIMITS, [10], NOON, A_WORKTREE_BUILD);
  assert.ok(Date.now() - holder.heldAt < JEV_BUDGET_LOCK_STALE_AFTER_MILLISECONDS);
  assert.deepEqual(beforeTheStaleBound, { outcome: JEV_BUDGET_LOCK_BUSY });
  await sleep(holder.heldAt + JEV_BUDGET_LOCK_STALE_AFTER_MILLISECONDS - Date.now());
  assert.equal(grantedIds(await reserveJevTokens(dataHome, LIMITS, [10], NOON, A_WORKTREE_BUILD)).length, 1);
  assert.deepEqual(await readJevSpend(dataHome, NOON), { todayTokens: 10, lastHourTokens: 10 });
});

test('a busy budget lock is reported as busy rather than as an error', async () => {
  const dataHome = await scratchDataHome();
  const release = await acquireAtomicMkdirLock({ lockPath: jevBudgetLockPath(dataHome), holder: 'a live spender' });
  try {
    assert.deepEqual(await reserveJevTokens(dataHome, LIMITS, [10], NOON, A_WORKTREE_BUILD), { outcome: JEV_BUDGET_LOCK_BUSY });
  } finally {
    await release();
  }
  assert.deepEqual(await readJevSpend(dataHome, NOON), { todayTokens: 0, lastHourTokens: 0 });
});

test('a higher-stamp build outside the live checkout spends without locking the live build out of Jev', async () => {
  const dataHome = await scratchDataHome();
  grantedIds(await reserveJevTokens(dataHome, LIMITS, [10], NOON, THE_LIVE_BUILD));
  grantedIds(await reserveJevTokens(dataHome, LIMITS, [10], NOON, A_NEWER_WORKTREE_BUILD));
  grantedIds(await reserveJevTokens(dataHome, LIMITS, [10], NOON, THE_LIVE_BUILD));
  assert.equal((await readJevSpend(dataHome, NOON)).todayTokens, 30);
});

test('a build older than the limiter version the live build spent with is refused and spends nothing', async () => {
  const dataHome = await scratchDataHome();
  grantedIds(await reserveJevTokens(dataHome, LIMITS, [10], NOON, A_NEWER_LIVE_BUILD));
  assert.deepEqual(await reserveJevTokens(dataHome, LIMITS, [10], NOON, THE_LIVE_BUILD), {
    outcome: JEV_BUDGET_OUTDATED_BUILD,
    recordedLimiterVersion: JEV_LIMITER_VERSION + 1,
  });
  assert.equal((await readJevSpend(dataHome, NOON)).todayTokens, 10);
});
