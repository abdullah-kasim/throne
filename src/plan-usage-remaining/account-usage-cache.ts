import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HARNESS_NAMES } from '../harness-routing/harness.ts';
import { isPlainObject } from '../shared-policy/config-value-shape.ts';
import { resolveThroneHome } from '../shared-policy/throne-home.ts';
import { USAGE_READING_SOURCES, type UsagePayload, type UsageReadingSource } from './telemetry.types.ts';

export const USAGE_READING_FRESH_MS = 120_000;
export const FIRST_BACK_OFF_MS = 300_000;
export const LONGEST_BACK_OFF_MS = 1_800_000;
export const ABANDONED_REFRESH_CLAIM_MS = 60_000;

export interface LiveUsageReading {
  payload: UsagePayload;
  rateLimited: boolean;
}

interface BackOff {
  lengthMs: number;
  untilMs: number;
}

interface AccountUsageCacheEntry {
  lastGood?: UsagePayload;
  backOff?: BackOff;
}

export function accountUsageCacheFile(accountFolder: string, environment: NodeJS.ProcessEnv = process.env): string {
  const folderKey = path.resolve(accountFolder).split(path.sep).filter((part) => part !== '').join('-');
  return path.join(resolveThroneHome(environment), 'usage-cache', 'claude-accounts', `${folderKey}.json`);
}

function withSource(payload: UsagePayload, source: UsageReadingSource): UsagePayload {
  return { ...payload, reading_source: source };
}

export function liveUsagePayload(live: LiveUsageReading): UsagePayload {
  return live.payload.source === 'api' ? withSource(live.payload, USAGE_READING_SOURCES.FRESH) : live.payload;
}

function parseCacheEntry(raw: string): AccountUsageCacheEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlainObject(parsed)) return {};
  const lastGood = isPlainObject(parsed.lastGood) && parsed.lastGood.source === 'api' ? (parsed.lastGood as unknown as UsagePayload) : undefined;
  const backOff = isPlainObject(parsed.backOff) && typeof parsed.backOff.lengthMs === 'number' && typeof parsed.backOff.untilMs === 'number'
    ? { lengthMs: parsed.backOff.lengthMs, untilMs: parsed.backOff.untilMs }
    : undefined;
  return { lastGood, backOff };
}

async function readCacheEntry(cacheFile: string): Promise<AccountUsageCacheEntry> {
  try {
    return parseCacheEntry(await readFile(cacheFile, 'utf8'));
  } catch {
    return {};
  }
}

export async function writeCacheEntry(cacheFile: string, entry: AccountUsageCacheEntry): Promise<void> {
  const temporaryFile = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(temporaryFile, JSON.stringify(entry), 'utf8');
    await rename(temporaryFile, cacheFile);
  } catch {
    await rm(temporaryFile, { force: true });
  }
}

function isFresh(reading: UsagePayload, nowMs: number): boolean {
  const ageMs = nowMs - Date.parse(reading.as_of);
  return ageMs >= 0 && ageMs < USAGE_READING_FRESH_MS;
}

function isBackingOff(backOff: BackOff, nowMs: number): boolean {
  const remainingMs = backOff.untilMs - nowMs;
  return remainingMs > 0 && remainingMs <= backOff.lengthMs;
}

function nextBackOff(previous: BackOff | undefined, nowMs: number): BackOff {
  const lengthMs = previous === undefined ? FIRST_BACK_OFF_MS : Math.min(previous.lengthMs * 2, LONGEST_BACK_OFF_MS);
  return { lengthMs, untilMs: nowMs + lengthMs };
}

function heldBackPayload(backOff: BackOff, now: Date): UsagePayload {
  return {
    source: 'error',
    harness: HARNESS_NAMES.CLAUDE,
    as_of: now.toISOString(),
    error: `Claude usage request held back after HTTP 429 until ${new Date(backOff.untilMs).toISOString()}`,
  };
}

function refreshClaimFile(cacheFile: string): string {
  return `${cacheFile}.refreshing`;
}

async function createRefreshClaim(cacheFile: string): Promise<boolean> {
  try {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(refreshClaimFile(cacheFile), String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

async function isRefreshClaimAbandoned(cacheFile: string): Promise<boolean> {
  try {
    const claim = await stat(refreshClaimFile(cacheFile));
    return Math.abs(Date.now() - claim.mtimeMs) >= ABANDONED_REFRESH_CLAIM_MS;
  } catch {
    return true;
  }
}

async function claimRefresh(cacheFile: string): Promise<boolean> {
  if (await createRefreshClaim(cacheFile)) return true;
  if (!(await isRefreshClaimAbandoned(cacheFile))) return false;
  await rm(refreshClaimFile(cacheFile), { force: true });
  return createRefreshClaim(cacheFile);
}

async function refreshReading(
  readLive: () => Promise<LiveUsageReading>,
  cacheFile: string,
  entry: AccountUsageCacheEntry,
  now: Date,
): Promise<UsagePayload> {
  const live = await readLive();
  if (live.payload.source === 'api') {
    await writeCacheEntry(cacheFile, { lastGood: live.payload });
    return liveUsagePayload(live);
  }
  if (!live.rateLimited) return live.payload;
  await writeCacheEntry(cacheFile, { ...entry, backOff: nextBackOff(entry.backOff, now.getTime()) });
  return entry.lastGood === undefined
    ? live.payload
    : withSource(entry.lastGood, USAGE_READING_SOURCES.LAST_GOOD_AFTER_RATE_LIMIT);
}

export async function readUsageThroughCache(
  readLive: () => Promise<LiveUsageReading>,
  cacheFile: string,
  now: Date,
): Promise<UsagePayload> {
  const entry = await readCacheEntry(cacheFile);
  const { lastGood, backOff } = entry;
  if (lastGood !== undefined && isFresh(lastGood, now.getTime())) return withSource(lastGood, USAGE_READING_SOURCES.CACHED);
  if (backOff !== undefined && isBackingOff(backOff, now.getTime())) {
    return lastGood === undefined
      ? heldBackPayload(backOff, now)
      : withSource(lastGood, USAGE_READING_SOURCES.LAST_GOOD_AFTER_RATE_LIMIT);
  }
  if (lastGood === undefined) return refreshReading(readLive, cacheFile, entry, now);
  if (!(await claimRefresh(cacheFile))) return withSource(lastGood, USAGE_READING_SOURCES.CACHED);
  try {
    return await refreshReading(readLive, cacheFile, entry, now);
  } finally {
    await rm(refreshClaimFile(cacheFile), { force: true });
  }
}
