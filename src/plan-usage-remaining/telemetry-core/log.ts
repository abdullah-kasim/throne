// The single source of truth for the bounded plan-usage log at
// `data/stats/usages/usage-log.jsonl` — its row shape, its serialization, its
// tolerant parse, and the real append/read IO. Both usage sensors
// (`plan-usage-remaining`, `codex-usage-remaining`) build rows here and append
// through `realAppendUsageLog`; the `usage-rate` reader parses back through
// `parseUsageLog`. Keeping build + serialize + parse in one module means the
// on-disk line format and the format callers read can never drift apart.
//
// `data/` is gitignored: this log is local-only, one JSONL object per (reading,
// cap window). Eight days retains the existing seven-day usage-rate lens plus
// boundary slack. 4,096 rows covers ten window series at the normal 30-minute
// sensor cadence while preventing an unexpectedly busy caller from growing the
// local file forever.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import {
  contemporaneousWeeklyReset,
  isFableWeeklyReading,
} from './weekly-reset.ts';
import type { CacheablePayload } from './cache.ts';
import type { UsageForecastSample } from './forecast.ts';
import { RUNTIME_DATA_DIR } from '../../shared-policy/runtime-data-home.ts';

// Resolve the throne root from THIS module's location, not process.cwd(), so the
// CLI and the in-process callers (create-agent's router, the FF keep-going hook)
// all append to the one file regardless of where the process was launched.
export const USAGE_LOG_DIR = path.join(RUNTIME_DATA_DIR, 'stats', 'usages');
export const USAGE_LOG_FILE = path.join(USAGE_LOG_DIR, 'usage-log.jsonl');
export const USAGE_LOG_MAX_AGE_MS = 8 * 24 * 60 * 60_000;
export const USAGE_LOG_MAX_ROWS = 4_096;

/** One appended reading for one cap window — the pinned on-disk row shape. */
export interface UsageLogRow {
  recorded_at: string; // ISO-8601 observation time (the logging moment)
  harness: string; // "claude" | "codex"
  cap_window: string; // "5h" | "weekly" | "weekly:Fable" | ...
  remaining_pct: number;
  reset_time: string | null; // null when the window carried none
}

/** Build the reading-set for one payload: one row per window, stamped with
 *  `recordedAt`. Returns [] for a non-`api` or windowless payload — this is the
 *  single place "never log an error or empty reading" is decided. */
export function buildUsageLogRows(
  payload: CacheablePayload,
  recordedAt: string,
): UsageLogRow[] {
  if (payload.source !== 'api' || payload.windows === undefined) return [];
  return payload.windows.map((window) => ({
    recorded_at: recordedAt,
    harness: payload.harness,
    cap_window: window.cap_window,
    remaining_pct: window.remaining_pct,
    reset_time: window.reset_time ?? null,
  }));
}

/** The one place a row becomes a line: each row -> JSON + "\n", concatenated.
 *  Empty input yields "" so appending [] is a no-op. */
export function serializeUsageLogRows(rows: UsageLogRow[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce one parsed line to a row, or undefined if it fails the shape check.
 *  An absent `reset_time` defaults to null; a present-but-non-(string|null)
 *  `reset_time` fails the check (the line is dropped, not silently repaired). */
function toUsageLogRow(value: unknown): UsageLogRow | undefined {
  if (!isRecord(value)) return undefined;
  const { recorded_at, harness, cap_window, remaining_pct, reset_time } = value;
  if (
    typeof recorded_at !== 'string' ||
    typeof harness !== 'string' ||
    typeof cap_window !== 'string' ||
    typeof remaining_pct !== 'number' ||
    !Number.isFinite(remaining_pct)
  ) {
    return undefined;
  }
  if (reset_time !== undefined && reset_time !== null && typeof reset_time !== 'string') {
    return undefined;
  }
  return {
    recorded_at,
    harness,
    cap_window,
    remaining_pct,
    reset_time: typeof reset_time === 'string' ? reset_time : null,
  };
}

/** Tolerant reader: split on newlines, skip blank and malformed lines, and keep
 *  only rows passing the shape check. A corrupt line is skipped, never fatal —
 *  a single bad append must not poison the whole trend. */
export function parseUsageLog(raw: string): UsageLogRow[] {
  const rows: UsageLogRow[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const row = toUsageLogRow(parsed);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

/** Retain schema-valid, non-future rows no older than eight days, then cap the
 *  complete log to its newest 4,096 rows. Input order breaks equal-time ties so
 *  reading sets remain stable. */
export function boundUsageLogRows(
  rows: readonly UsageLogRow[],
  now: Date,
): UsageLogRow[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return [];
  return rows
    .map((row, order) => ({ row, order, recordedAt: Date.parse(row.recorded_at) }))
    .filter(
      ({ row, recordedAt }) =>
        Number.isFinite(recordedAt) &&
        recordedAt <= nowMs &&
        nowMs - recordedAt <= USAGE_LOG_MAX_AGE_MS &&
        row.remaining_pct >= 0 &&
        row.remaining_pct <= 100,
    )
    .sort((left, right) => left.recordedAt - right.recordedAt || left.order - right.order)
    .slice(-USAGE_LOG_MAX_ROWS)
    .map(({ row }) => row);
}

function recordedBatchKey(row: UsageLogRow): string {
  return `${row.harness}\n${row.recorded_at}`;
}

export function withInheritedFableWeeklyReset(
  rows: readonly UsageLogRow[],
): UsageLogRow[] {
  const batches = new Map<string, UsageLogRow[]>();
  for (const row of rows) {
    const key = recordedBatchKey(row);
    const batch = batches.get(key);
    if (batch === undefined) batches.set(key, [row]);
    else batch.push(row);
  }
  return rows.map((row) => {
    if (row.reset_time !== null || !isFableWeeklyReading(row)) return row;
    const inheritedReset = contemporaneousWeeklyReset(
      batches.get(recordedBatchKey(row)) ?? [],
    );
    return inheritedReset === undefined ? row : { ...row, reset_time: inheritedReset };
  });
}

/** Narrow adapter from persisted rows to the pure forecast contract. */
export function getBoundedForecastSamples(
  rows: readonly UsageLogRow[],
  harness: string,
  capWindow: string,
  now: Date,
): UsageForecastSample[] {
  return withInheritedFableWeeklyReset(boundUsageLogRows(rows, now))
    .filter((row) => row.harness === harness && row.cap_window === capWindow)
    .map(({ recorded_at, remaining_pct, reset_time }) => ({
      recorded_at,
      remaining_pct,
      reset_time,
    }));
}

interface UsageLogAppenderOptions {
  file?: string;
  now?: () => Date;
  flockExecutable?: string;
}

function acquireDescriptorLock(descriptor: number, flockExecutable: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(flockExecutable, ['--exclusive', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', descriptor],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim();
      reject(
        new Error(
          `${flockExecutable} could not acquire the usage log lock` +
            `${signal === null ? ` (exit ${code ?? 'unknown'})` : ` (${signal})`}` +
            `${detail === '' ? '' : `: ${detail}`}`,
        ),
      );
    });
  });
}

async function readAbsentAsEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (isRecord(err) && err.code === 'ENOENT') return '';
    throw err;
  }
}

async function closeWithoutChangingOutcome(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  try {
    await handle.close();
  } catch {
    return;
  }
}

async function unlinkWithoutChangingOutcome(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch {
    return;
  }
}

/** The real append seam bound on each command's REAL_DEPS. Every writer holds
 *  the same kernel lock across read, bound, and atomic replacement, so parallel
 *  Claude/Codex reading sets cannot interleave or overwrite one another. */
export function realAppendUsageLog(
  options: UsageLogAppenderOptions = {},
): (rows: UsageLogRow[]) => Promise<void> {
  const file = options.file ?? USAGE_LOG_FILE;
  const now = options.now ?? (() => new Date());
  const flockExecutable = options.flockExecutable ?? 'flock';
  return async (rows) => {
    if (rows.length === 0) return;
    const directory = path.dirname(file);
    const lockFile = `${file}.lock`;
    const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let lockHandle: FileHandle | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      lockHandle = await open(lockFile, 'a+', 0o600);
      await lockHandle.chmod(0o600);
      await acquireDescriptorLock(lockHandle.fd, flockExecutable);
      const retained = boundUsageLogRows(
        [...parseUsageLog(await readAbsentAsEmpty(file)), ...rows],
        now(),
      );
      await writeFile(temporaryFile, serializeUsageLogRows(retained), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryFile, file);
    } finally {
      await unlinkWithoutChangingOutcome(temporaryFile);
      await closeWithoutChangingOutcome(lockHandle);
    }
  };
}

/** Read the raw log for the rate reader. An absent log (ENOENT) resolves to ""
 *  so the caller parses to [] rather than handling a read error. */
export async function readUsageLogRaw(): Promise<string> {
  try {
    return await readFile(USAGE_LOG_FILE, 'utf8');
  } catch (err) {
    if (isRecord(err) && err.code === 'ENOENT') return '';
    throw err;
  }
}
