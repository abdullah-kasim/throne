import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  acquireAtomicMkdirLock,
  AtomicMkdirLockTimedOutError,
} from '../alpha-monitoring/atomic-mkdir-lock.ts';
import type { JevLimiterBuild } from './jev-limiter-build.ts';
import { recallDirectoryInDataHome } from './jev-usage-log.ts';

export const JEV_BUDGET_LOCK_STALE_AFTER_MILLISECONDS = 3000;
export const JEV_BUDGET_LOCK_RETRY_MILLISECONDS = 20;
export const JEV_BUDGET_LOCK_ATTEMPTS = 80;
const MILLISECONDS_PER_HOUR = 3_600_000;
const JEV_BUDGET_TALLY_FILE_NAME = 'tally.json';
const JEV_BUDGET_LOCK_DIRECTORY_NAME = 'lock';

export const JEV_TOKENS_PER_DAY_LIMIT = 'tokens per day';
export const JEV_TOKENS_PER_HOUR_LIMIT = 'tokens per hour';
export type JevLimitName = typeof JEV_TOKENS_PER_DAY_LIMIT | typeof JEV_TOKENS_PER_HOUR_LIMIT;

export const JEV_BUDGET_GRANTED = 'granted';
export const JEV_BUDGET_REFUSED = 'refused';
export const JEV_BUDGET_SETTLED = 'settled';
export const JEV_BUDGET_LOCK_BUSY = 'lock busy';
export const JEV_BUDGET_OUTDATED_BUILD = 'outdated build';

export interface JevLimits {
  readonly tokensPerDay: number;
  readonly tokensPerHour: number;
}

export type JevReservation =
  | { readonly outcome: typeof JEV_BUDGET_GRANTED; readonly reservationIds: readonly string[] }
  | {
      readonly outcome: typeof JEV_BUDGET_REFUSED;
      readonly limit: JevLimitName;
      readonly spentTokens: number;
      readonly limitTokens: number;
    }
  | { readonly outcome: typeof JEV_BUDGET_LOCK_BUSY }
  | { readonly outcome: typeof JEV_BUDGET_OUTDATED_BUILD; readonly recordedLimiterVersion: number };

export type JevSettlement = typeof JEV_BUDGET_SETTLED | typeof JEV_BUDGET_LOCK_BUSY;

export interface JevSpend {
  readonly todayTokens: number;
  readonly lastHourTokens: number;
}

interface JevReservedTokens {
  readonly id: string;
  readonly reservedAt: number;
  readonly tokens: number;
}

interface JevBudgetTally {
  readonly day: string;
  readonly dayTokens: number;
  readonly lastHourReservations: readonly JevReservedTokens[];
  readonly highestLiveLimiterVersion: number;
}

type StoredJevBudgetTally = Omit<JevBudgetTally, 'highestLiveLimiterVersion'> & {
  readonly highestLiveLimiterVersion?: number;
};

const NO_LIMITER_VERSION_RECORDED = 0;

export function jevBudgetDirectory(dataHome: string): string {
  return path.join(recallDirectoryInDataHome(dataHome), 'jev-budget');
}

export function jevBudgetTallyPath(dataHome: string): string {
  return path.join(jevBudgetDirectory(dataHome), JEV_BUDGET_TALLY_FILE_NAME);
}

export function jevBudgetLockPath(dataHome: string): string {
  return path.join(jevBudgetDirectory(dataHome), JEV_BUDGET_LOCK_DIRECTORY_NAME);
}

export function localDate(moment: Date): string {
  const month = String(moment.getMonth() + 1).padStart(2, '0');
  const day = String(moment.getDate()).padStart(2, '0');
  return `${moment.getFullYear()}-${month}-${day}`;
}

function isWithinTheLastHour(reservedAt: number, now: Date): boolean {
  return reservedAt > now.getTime() - MILLISECONDS_PER_HOUR;
}

function tallyAsOf(tally: StoredJevBudgetTally, now: Date): JevBudgetTally {
  const today = localDate(now);
  return {
    day: today,
    dayTokens: tally.day === today ? tally.dayTokens : 0,
    lastHourReservations: tally.lastHourReservations.filter((reservation) =>
      isWithinTheLastHour(reservation.reservedAt, now),
    ),
    highestLiveLimiterVersion: tally.highestLiveLimiterVersion ?? NO_LIMITER_VERSION_RECORDED,
  };
}

function lastHourTokens(tally: JevBudgetTally): number {
  return tally.lastHourReservations.reduce((total, reservation) => total + reservation.tokens, 0);
}

async function readJevBudgetTally(dataHome: string, now: Date): Promise<JevBudgetTally> {
  try {
    const tally = JSON.parse(await readFile(jevBudgetTallyPath(dataHome), 'utf8')) as StoredJevBudgetTally;
    return tallyAsOf(tally, now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        day: localDate(now),
        dayTokens: 0,
        lastHourReservations: [],
        highestLiveLimiterVersion: NO_LIMITER_VERSION_RECORDED,
      };
    }
    throw error;
  }
}

async function replaceJevBudgetTally(dataHome: string, tally: JevBudgetTally): Promise<void> {
  const temporaryPath = `${jevBudgetTallyPath(dataHome)}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(tally), 'utf8');
  try {
    await rename(temporaryPath, jevBudgetTallyPath(dataHome));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function withJevBudgetLock<Result>(
  dataHome: string,
  work: () => Promise<Result>,
): Promise<Result | typeof JEV_BUDGET_LOCK_BUSY> {
  await mkdir(jevBudgetDirectory(dataHome), { recursive: true });
  let release: () => Promise<void>;
  try {
    release = await acquireAtomicMkdirLock({
      lockPath: jevBudgetLockPath(dataHome),
      holder: `jev budget, pid ${process.pid}`,
      staleAfterMs: JEV_BUDGET_LOCK_STALE_AFTER_MILLISECONDS,
      retryMs: JEV_BUDGET_LOCK_RETRY_MILLISECONDS,
      attempts: JEV_BUDGET_LOCK_ATTEMPTS,
    });
  } catch (error) {
    if (error instanceof AtomicMkdirLockTimedOutError) return JEV_BUDGET_LOCK_BUSY;
    throw error;
  }
  try {
    return await work();
  } finally {
    await release();
  }
}

function refusalOf(tally: JevBudgetTally, limits: JevLimits, batchTokens: number): JevReservation | undefined {
  if (tally.dayTokens + batchTokens > limits.tokensPerDay) {
    return {
      outcome: JEV_BUDGET_REFUSED,
      limit: JEV_TOKENS_PER_DAY_LIMIT,
      spentTokens: tally.dayTokens,
      limitTokens: limits.tokensPerDay,
    };
  }
  if (lastHourTokens(tally) + batchTokens > limits.tokensPerHour) {
    return {
      outcome: JEV_BUDGET_REFUSED,
      limit: JEV_TOKENS_PER_HOUR_LIMIT,
      spentTokens: lastHourTokens(tally),
      limitTokens: limits.tokensPerHour,
    };
  }
  return undefined;
}

function isOlderThanTheRecordedLimiter(build: JevLimiterBuild, tally: JevBudgetTally): boolean {
  return build.limiterVersion < tally.highestLiveLimiterVersion;
}

function limiterVersionToRecord(build: JevLimiterBuild, tally: JevBudgetTally): number {
  return build.runsFromTheLiveCheckout
    ? Math.max(tally.highestLiveLimiterVersion, build.limiterVersion)
    : tally.highestLiveLimiterVersion;
}

export async function reserveJevTokens(
  dataHome: string,
  limits: JevLimits,
  estimatedTokensPerRequest: readonly number[],
  now: Date,
  build: JevLimiterBuild,
): Promise<JevReservation> {
  const reservation = await withJevBudgetLock(dataHome, async (): Promise<JevReservation> => {
    const tally = await readJevBudgetTally(dataHome, now);
    if (isOlderThanTheRecordedLimiter(build, tally)) {
      return { outcome: JEV_BUDGET_OUTDATED_BUILD, recordedLimiterVersion: tally.highestLiveLimiterVersion };
    }
    const batchTokens = estimatedTokensPerRequest.reduce((total, tokens) => total + tokens, 0);
    const refusal = refusalOf(tally, limits, batchTokens);
    if (refusal !== undefined) return refusal;
    const reserved = estimatedTokensPerRequest.map((tokens) => ({
      id: randomUUID(),
      reservedAt: now.getTime(),
      tokens,
    }));
    await replaceJevBudgetTally(dataHome, {
      day: tally.day,
      dayTokens: tally.dayTokens + batchTokens,
      lastHourReservations: [...tally.lastHourReservations, ...reserved],
      highestLiveLimiterVersion: limiterVersionToRecord(build, tally),
    });
    return { outcome: JEV_BUDGET_GRANTED, reservationIds: reserved.map((entry) => entry.id) };
  });
  return reservation === JEV_BUDGET_LOCK_BUSY ? { outcome: JEV_BUDGET_LOCK_BUSY } : reservation;
}

function tallyWithRealTokens(tally: JevBudgetTally, reservationId: string, realTokens: number): JevBudgetTally {
  const reserved = tally.lastHourReservations.find((reservation) => reservation.id === reservationId);
  if (reserved === undefined) return tally;
  const reservedToday = localDate(new Date(reserved.reservedAt)) === tally.day;
  return {
    ...tally,
    dayTokens: reservedToday ? tally.dayTokens + realTokens - reserved.tokens : tally.dayTokens,
    lastHourReservations: tally.lastHourReservations.map((reservation) =>
      reservation.id === reservationId ? { ...reservation, tokens: realTokens } : reservation,
    ),
  };
}

export async function settleJevReservation(
  dataHome: string,
  reservationId: string,
  realTokens: number | undefined,
  now: Date,
): Promise<JevSettlement> {
  if (realTokens === undefined) return JEV_BUDGET_SETTLED;
  return withJevBudgetLock(dataHome, async (): Promise<typeof JEV_BUDGET_SETTLED> => {
    const tally = await readJevBudgetTally(dataHome, now);
    await replaceJevBudgetTally(dataHome, tallyWithRealTokens(tally, reservationId, realTokens));
    return JEV_BUDGET_SETTLED;
  });
}

export async function readJevSpend(dataHome: string, now: Date): Promise<JevSpend> {
  const tally = await readJevBudgetTally(dataHome, now);
  return { todayTokens: tally.dayTokens, lastHourTokens: lastHourTokens(tally) };
}
