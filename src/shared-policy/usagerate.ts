// Pure burn-rate math over the append-only usage log. Given the logged
// remaining-percent readings, compute how fast plan headroom is being consumed —
// today's average and a trailing 7-day average, in percent per hour — per
// (harness, cap_window). The CLI (`commands/usage-rate.ts`) is a thin wrapper;
// all the logic lives here so it is unit-testable from a plain fixture.
//
// Anchor (no wall-clock): both windows are measured relative to the NEWEST
// reading in the log (max recorded_at), never a live clock. The log is appended
// on every usage-tool call, so the newest reading is practically "now", and
// anchoring to it makes the result deterministic and testable from a pure
// fixture. "today" therefore means the current UTC calendar day CONTAINING the
// newest reading — a UTC boundary, not local midnight, because every logged
// timestamp is UTC and it keeps the math timezone-independent. The 7-day window
// is the newest reading minus 7×24h.
//
// Reset segmentation: remaining_pct falls as plan is used and JUMPS UP at a
// reset. Burn is only measured within a single reset segment; the interval that
// spans a reset contributes no consumption and no elapsed time (a reset gap is
// not a measurement), so a reset never shows up as negative burn, and intra-
// window noise is clamped so a tiny up-tick never yields negative burn either.
//
// Deciding the segment boundary from the reset instant: the reset instant is a
// window's identity — it advances by a whole window length (the shortest cap
// window is 5h) when the window actually resets. The live usage endpoint,
// however, recomputes `resets_at` on every call, so within one un-reset window
// the reported instant jitters sub-second (observed: 05:30:00.463705 vs
// 05:29:59.925705 for the same 5h window while remaining fell 63→49). Those are
// the SAME window, so the boundary is decided by comparing reset INSTANTS with a
// jitter tolerance — raw timestamp equality would misread every jittered reading
// as a reset and erase all real burn. When a reset instant is missing or
// unparseable the only signal left is remaining_pct itself jumping up.

import type { UsageLogRow } from '../plan-usage-remaining/telemetry-core/log.ts';

/** Floating-point slack for the "remaining jumped up" reset test. */
export const EPS = 1e-9;

const MS_PER_HOUR = 3_600_000;
const SEVEN_DAY_MS = 7 * 24 * MS_PER_HOUR;

// A real reset advances the reset instant by at least one window length (the
// shortest cap window is 5h = 300 min); the endpoint's per-call recomputation
// jitters it by under a second. 60s sits far above the jitter and far below any
// real reset gap, so a reset-instant difference beyond it marks a genuine reset.
const RESET_INSTANT_JITTER_TOLERANCE_MS = 60_000;

export interface RateWindow {
  pct_per_hour: number | null; // null = insufficient data (never negative, never Infinity)
  consumed_pct: number; // Σ clamped consumed over non-boundary intervals
  elapsed_hours: number; // Σ positive elapsed over non-boundary intervals
  reading_count: number; // in-window readings for this group
  segment_count: number; // reset-segments the in-window subset spans
}

export interface RateResult {
  harness: string;
  cap_window: string;
  today: RateWindow;
  seven_day: RateWindow;
}

interface Reading {
  harness: string;
  cap_window: string;
  t: number; // recorded_at parsed to epoch ms
  remaining_pct: number;
  reset_time: string | null;
  order: number; // input index — a stable tie-break for equal timestamps
}

interface Group {
  harness: string;
  cap_window: string;
  readings: Reading[];
}

/** Drop rows whose remaining_pct is non-finite or whose recorded_at will not
 *  parse, stamping each survivor with its parsed timestamp and input order. */
function parseReadings(rows: UsageLogRow[]): Reading[] {
  const readings: Reading[] = [];
  rows.forEach((row, order) => {
    const t = Date.parse(row.recorded_at);
    if (!Number.isFinite(t) || !Number.isFinite(row.remaining_pct)) return;
    readings.push({
      harness: row.harness,
      cap_window: row.cap_window,
      t,
      remaining_pct: row.remaining_pct,
      reset_time: row.reset_time,
      order,
    });
  });
  return readings;
}

function startOfUTCDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** True when the step prev→cur crosses a reset (a new segment starts at cur).
 *  With both reset instants known, a reset advances the instant by a window
 *  length, so a difference beyond sub-second jitter marks the boundary. With a
 *  missing/unparseable instant, the surviving signal is remaining_pct jumping
 *  up — a rise with no comparable reset instant is itself a reset. */
function crossesReset(prev: Reading, cur: Reading): boolean {
  const prevReset = prev.reset_time === null ? Number.NaN : Date.parse(prev.reset_time);
  const curReset = cur.reset_time === null ? Number.NaN : Date.parse(cur.reset_time);
  if (Number.isFinite(prevReset) && Number.isFinite(curReset)) {
    return Math.abs(curReset - prevReset) > RESET_INSTANT_JITTER_TOLERANCE_MS;
  }
  return cur.remaining_pct > prev.remaining_pct + EPS;
}

/** Burn over the readings falling inside one window, walking consecutive pairs
 *  within a single group. A reset interval is skipped whole; a normal interval
 *  adds clamped consumption and — only when time actually advanced — elapsed
 *  time, so duplicate timestamps never inflate the denominator. */
function computeWindow(sorted: Reading[], windowStart: number): RateWindow {
  const inWindow = sorted.filter((reading) => reading.t >= windowStart);
  let consumed = 0;
  let elapsedMs = 0;
  let boundaries = 0;
  let prev: Reading | undefined;
  for (const cur of inWindow) {
    if (prev !== undefined) {
      if (crossesReset(prev, cur)) {
        boundaries += 1;
      } else {
        consumed += Math.max(0, prev.remaining_pct - cur.remaining_pct);
        if (cur.t > prev.t) elapsedMs += cur.t - prev.t;
      }
    }
    prev = cur;
  }
  const elapsed_hours = elapsedMs / MS_PER_HOUR;
  return {
    pct_per_hour: elapsed_hours > 0 ? consumed / elapsed_hours : null,
    consumed_pct: consumed,
    elapsed_hours,
    reading_count: inWindow.length,
    segment_count: inWindow.length === 0 ? 0 : 1 + boundaries,
  };
}

// A NUL delimiter can never occur in a harness or cap_window label, so the
// grouping key stays unambiguous whatever those strings contain.
const GROUP_KEY_SEP = '\u0000';

function groupByHarnessWindow(readings: Reading[]): Group[] {
  const groups = new Map<string, Group>();
  for (const reading of readings) {
    const key = `${reading.harness}${GROUP_KEY_SEP}${reading.cap_window}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { harness: reading.harness, cap_window: reading.cap_window, readings: [] };
      groups.set(key, group);
    }
    group.readings.push(reading);
  }
  return [...groups.values()];
}

function byHarnessThenWindow(a: RateResult, b: RateResult): number {
  if (a.harness !== b.harness) return a.harness < b.harness ? -1 : 1;
  if (a.cap_window !== b.cap_window) return a.cap_window < b.cap_window ? -1 : 1;
  return 0;
}

/** Pure. Anchors to max(recorded_at) internally. Returns an empty result set for
 *  empty input. Results are sorted by (harness, cap_window) for deterministic
 *  output. */
export function computeUsageRates(
  rows: UsageLogRow[],
): { anchor: string | null; results: RateResult[] } {
  const readings = parseReadings(rows);
  if (readings.length === 0) return { anchor: null, results: [] };

  let anchorMs = Number.NEGATIVE_INFINITY;
  for (const reading of readings) {
    if (reading.t > anchorMs) anchorMs = reading.t;
  }
  const todayStart = startOfUTCDay(anchorMs);
  const sevenDayStart = anchorMs - SEVEN_DAY_MS;

  const results = groupByHarnessWindow(readings).map((group) => {
    const sorted = [...group.readings].sort((a, b) => a.t - b.t || a.order - b.order);
    return {
      harness: group.harness,
      cap_window: group.cap_window,
      today: computeWindow(sorted, todayStart),
      seven_day: computeWindow(sorted, sevenDayStart),
    };
  });
  results.sort(byHarnessThenWindow);

  return { anchor: new Date(anchorMs).toISOString(), results };
}
