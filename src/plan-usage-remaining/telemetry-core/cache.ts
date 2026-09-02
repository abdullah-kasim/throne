// The shared last-good usage cache — the one place a usage read rides through a
// transient endpoint blip. Both usage sensors (`plan-usage-remaining` and
// `codex-usage-remaining`) wrap their live fetch in `cachedUsage`, so EVERY
// consumer inherits the same behavior: the harness router's per-spawn queries,
// FF's keep-going hook, and the standalone CLI calls. A fresh-enough reading is
// reused without a live call; a live-fetch error returns the last-good numbers
// marked `stale` instead of failing; a cold start with the endpoint down still
// fails honestly (there is no last-good to fall back to).
//
// The cache is per-harness (separate files) and best-effort: a read/parse
// failure is a miss, and a write failure is swallowed — caching never turns a
// good fetch into a failure. The IO (clock + file read/write) is injected, so
// the semantics are unit-tested hermetically.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { UsageWindow } from '../telemetry.types.ts';

/** Shared TTL: reuse a cached read within this window without refetching. Safe
 *  this long because the upstream usage sensor lags the wall-clock reset by
 *  ~80 minutes (measured 2026-07-20), so polling faster reads nothing newer —
 *  a longer TTL forfeits nothing that was not already stale and stops the
 *  CLI/log spam from every-minute live fetches. Also bounds how old an
 *  error-fallback value can be before the next live attempt. */
export const USAGE_CACHE_TTL_MS = 1_800_000; // 30 minutes

/** The payload shape the cache persists/returns — both sensors' payloads match it. */
export interface CacheablePayload {
  source: 'api' | 'error';
  harness: string;
  as_of: string;
  windows?: UsageWindow[];
  error?: string;
  stale?: boolean; // true when returned from cache after a live-fetch error
}

/** Injected cache IO (real impl reads/writes a per-harness file; tests inject in-memory). */
export interface UsageCacheIo {
  now: () => number; // epoch ms
  readCache: () => Promise<string>; // rejects when absent/unreadable
  writeCache: (data: string) => Promise<void>;
}

/** The persisted entry: a last-good `api` payload plus when it was cached. */
interface CacheEntry<T extends CacheablePayload> {
  payload: T;
  cachedAt: number;
}

function isCacheablePayload(value: unknown): value is CacheablePayload {
  if (typeof value !== 'object' || value === null) return false;
  const source = (value as { source?: unknown }).source;
  return source === 'api' || source === 'error';
}

/** Parse a persisted cache entry; any malformed shape is a miss (`undefined`). */
function parseCacheEntry<T extends CacheablePayload>(raw: string): CacheEntry<T> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.cachedAt !== 'number' || !isCacheablePayload(record.payload)) {
    return undefined;
  }
  return { payload: record.payload as T, cachedAt: record.cachedAt };
}

/** Read + parse the cache; an absent/unreadable/garbage cache is a miss. */
async function readCacheEntry<T extends CacheablePayload>(
  io: UsageCacheIo,
): Promise<CacheEntry<T> | undefined> {
  let raw: string;
  try {
    raw = await io.readCache();
  } catch {
    return undefined;
  }
  return parseCacheEntry<T>(raw);
}

/** Persist a fresh last-good payload. Best-effort: a write failure is swallowed. */
async function persistLastGood<T extends CacheablePayload>(
  io: UsageCacheIo,
  payload: T,
): Promise<void> {
  const entry: CacheEntry<T> = { payload, cachedAt: io.now() };
  try {
    await io.writeCache(JSON.stringify(entry));
  } catch {
    // Caching is best-effort — never fail a good fetch on a write error.
  }
}

/** Wrap a live fetch with the last-good cache semantics. Pure w.r.t. injected IO:
 *  1) a cached reading newer than `ttlMs` is reused without a live call;
 *  2) otherwise fetch — an `api` result is persisted and returned un-stale;
 *  3) on a live error WITH a last-good, return that cached payload marked
 *     `stale` (its original `as_of` kept, the live `error` carried);
 *  4) on a live error with NO cache, return the error payload unchanged. */
export async function cachedUsage<T extends CacheablePayload>(
  fetchLive: () => Promise<T>,
  io: UsageCacheIo,
  ttlMs: number = USAGE_CACHE_TTL_MS,
): Promise<T> {
  const cached = await readCacheEntry<T>(io);
  if (cached !== undefined && io.now() - cached.cachedAt < ttlMs) {
    return cached.payload;
  }

  const live = await fetchLive();
  if (live.source === 'api') {
    await persistLastGood(io, live);
    return live;
  }
  if (cached !== undefined) {
    // Ride through the blip on the real last-good number; keep its as_of, carry
    // the live error. `as T` bridges the generic — the shape is still a T.
    return { ...cached.payload, stale: true, error: live.error } as T;
  }
  return live;
}

/** Real IO for a harness: cache file at ~/.throne/usage-cache/<harness>.json
 *  (mkdir -p on write; ~/.throne is the throne-owned home already used for
 *  worktrees). */
export function realUsageCacheIo(harness: string): UsageCacheIo {
  const dir = path.join(homedir(), '.throne', 'usage-cache');
  const file = path.join(dir, `${harness}.json`);
  return {
    now: () => Date.now(),
    readCache: () => readFile(file, 'utf8'),
    writeCache: async (data) => {
      await mkdir(dir, { recursive: true });
      await writeFile(file, data, 'utf8');
    },
  };
}
