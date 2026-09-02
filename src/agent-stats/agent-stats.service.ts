import { Injectable } from "@nestjs/common";
// Pure lifecycle statistics over the append-only agent-timing log. The trailing
// window anchors to the newest parseable reap timestamp in the supplied rows,
// never a wall clock, so the same fixture always produces the same report.
// Unparseable timestamps remain visible in rows_total but cannot anchor or enter
// the window. Completed lifecycles without a duration stay explicitly counted
// while only measured durations contribute to the completion-speed mean.

import { REAP_REASON } from "../agent-timings/reap-reason.ts";
import type { AgentTimingRow } from "../agent-timings/agent-timing.types.ts";

/** Trailing window width: 7 days, measured back from the newest activity. */
export const TRAILING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** One breakdown line (a harness, a role, or the overall aggregate). */
export interface GroupStats {
  group: string;
  reaps_in_window: number;
  stalled_count: number;
  stall_rate: number | null;
  completed_count: number;
  completed_without_duration: number;
  avg_completion_ms: number | null;
}

export interface AgentStatsResult {
  anchor: string | null;
  window_start: string | null;
  rows_total: number;
  rows_in_window: number;
  overall: GroupStats;
  by_harness: GroupStats[];
  by_role: GroupStats[];
  reap_reasons: Record<string, number>;
}

export const AGENT_STATS_NO_DATA_LINE =
  "No agent timing rows logged yet (data/stats/agent-timings.jsonl empty or absent).";

function formatPercent(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "—";

  let remainingSeconds = Math.round(durationMs / 1_000);
  const days = Math.floor(remainingSeconds / 86_400);
  remainingSeconds %= 86_400;
  const hours = Math.floor(remainingSeconds / 3_600);
  remainingSeconds %= 3_600;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatGroupTable(groups: GroupStats[], heading: string): string[] {
  const values = groups.map((group) => ({
    group: group.group,
    reaps: String(group.reaps_in_window),
    stalled: String(group.stalled_count),
    stallRate: formatPercent(group.stall_rate),
    completed: String(group.completed_count),
    average: formatDuration(group.avg_completion_ms),
  }));
  const widths = {
    group: Math.max(
      "group".length,
      ...values.map((value) => value.group.length),
    ),
    reaps: Math.max(
      "reaps".length,
      ...values.map((value) => value.reaps.length),
    ),
    stalled: Math.max(
      "stalled".length,
      ...values.map((value) => value.stalled.length),
    ),
    stallRate: Math.max(
      "stall-rate".length,
      ...values.map((value) => value.stallRate.length),
    ),
    completed: Math.max(
      "completed".length,
      ...values.map((value) => value.completed.length),
    ),
    average: Math.max(
      "avg completion".length,
      ...values.map((value) => value.average.length),
    ),
  };
  const header = [
    `  ${"group".padEnd(widths.group)}`,
    "reaps".padStart(widths.reaps),
    "stalled".padStart(widths.stalled),
    "stall-rate".padStart(widths.stallRate),
    "completed".padStart(widths.completed),
    "avg completion".padStart(widths.average),
  ].join("  ");
  const lines = groups.map((group) => {
    const line = [
      `  ${group.group.padEnd(widths.group)}`,
      String(group.reaps_in_window).padStart(widths.reaps),
      String(group.stalled_count).padStart(widths.stalled),
      formatPercent(group.stall_rate).padStart(widths.stallRate),
      String(group.completed_count).padStart(widths.completed),
      formatDuration(group.avg_completion_ms).padStart(widths.average),
    ].join("  ");
    return group.completed_without_duration > 0
      ? `${line} (${group.completed_without_duration} completed lack duration)`
      : line;
  });
  return [heading, header, ...(lines.length > 0 ? lines : ["  (none)"])];
}

/** Format the human-readable agent-stats report without command or IO policy. */
export function formatAgentStatsHuman(result: AgentStatsResult): string[] {
  return [
    `Agent lifecycle stats — trailing 7 days (anchor: ${result.anchor ?? "none"}; window start: ${result.window_start ?? "none"})`,
    ...formatGroupTable(result.by_harness, "By harness"),
    ...formatGroupTable([result.overall], "Overall"),
    ...formatGroupTable(result.by_role, "By role"),
    "Reap reasons",
    ...Object.entries(result.reap_reasons).map(
      ([reason, count]) => `  ${reason}  ${count}`,
    ),
    ...(Object.keys(result.reap_reasons).length > 0 ? [] : ["  (none)"]),
  ];
}

const UNKNOWN_HARNESS_GROUP = "unknown";

function computeGroupStats(group: string, rows: AgentTimingRow[]): GroupStats {
  let stalledCount = 0;
  let completedCount = 0;
  let completedWithoutDuration = 0;
  let completionDurationTotal = 0;
  let completionDurationCount = 0;

  for (const row of rows) {
    if (row.reap_reason === REAP_REASON.STALLED) stalledCount += 1;
    if (row.reap_reason !== REAP_REASON.COMPLETED) continue;

    completedCount += 1;
    if (row.duration_ms === null) {
      completedWithoutDuration += 1;
    } else {
      completionDurationTotal += row.duration_ms;
      completionDurationCount += 1;
    }
  }

  return {
    group,
    reaps_in_window: rows.length,
    stalled_count: stalledCount,
    stall_rate: rows.length === 0 ? null : stalledCount / rows.length,
    completed_count: completedCount,
    completed_without_duration: completedWithoutDuration,
    avg_completion_ms:
      completionDurationCount === 0
        ? null
        : completionDurationTotal / completionDurationCount,
  };
}

function byGroupName(left: GroupStats, right: GroupStats): number {
  if (left.group === right.group) return 0;
  return left.group < right.group ? -1 : 1;
}

function computeGroupedStats(
  rows: AgentTimingRow[],
  groupFor: (row: AgentTimingRow) => string,
): GroupStats[] {
  const groupedRows = new Map<string, AgentTimingRow[]>();
  for (const row of rows) {
    const group = groupFor(row);
    const existing = groupedRows.get(group);
    if (existing === undefined) {
      groupedRows.set(group, [row]);
    } else {
      existing.push(row);
    }
  }

  return [...groupedRows]
    .map(([group, groupRows]) => computeGroupStats(group, groupRows))
    .sort(byGroupName);
}

function countReapReasons(rows: AgentTimingRow[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.reap_reason, (counts.get(row.reap_reason) ?? 0) + 1);
  }

  const sortedCounts: Record<string, number> = {};
  for (const reason of [...counts.keys()].sort()) {
    sortedCounts[reason] = counts.get(reason) ?? 0;
  }
  return sortedCounts;
}

/** Compute deterministic trailing-window lifecycle statistics from parsed rows. */
export function computeAgentStats(rows: AgentTimingRow[]): AgentStatsResult {
  const datedRows: Array<{ row: AgentTimingRow; reapedMs: number }> = [];
  let anchor: string | null = null;
  let anchorMs = Number.NEGATIVE_INFINITY;

  for (const row of rows) {
    const reapedMs = Date.parse(row.reaped_at);
    if (!Number.isFinite(reapedMs)) continue;
    datedRows.push({ row, reapedMs });
    if (reapedMs > anchorMs) {
      anchor = row.reaped_at;
      anchorMs = reapedMs;
    }
  }

  if (anchor === null) {
    return {
      anchor: null,
      window_start: null,
      rows_total: rows.length,
      rows_in_window: 0,
      overall: computeGroupStats("all", []),
      by_harness: [],
      by_role: [],
      reap_reasons: {},
    };
  }

  const windowStartMs = anchorMs - TRAILING_WINDOW_MS;
  const rowsInWindow = datedRows
    .filter(({ reapedMs }) => reapedMs >= windowStartMs)
    .map(({ row }) => row);
  // `scratch` marks a disposable diagnostic probe that completed no real
  // work — it is neither a genuine completion nor a stall, so it stays out
  // of the completion/stall breakdowns entirely while still showing up in
  // rows_in_window and the reap_reasons tally for visibility.
  const statsRows = rowsInWindow.filter(
    (row) => row.reap_reason !== REAP_REASON.SCRATCH,
  );

  return {
    anchor,
    window_start: new Date(windowStartMs).toISOString(),
    rows_total: rows.length,
    rows_in_window: rowsInWindow.length,
    overall: computeGroupStats("all", statsRows),
    by_harness: computeGroupedStats(
      statsRows,
      (row) => row.harness ?? UNKNOWN_HARNESS_GROUP,
    ),
    by_role: computeGroupedStats(statsRows, (row) => row.role),
    reap_reasons: countReapReasons(rowsInWindow),
  };
}

@Injectable()
export class AgentStatsService {
  readonly computeAgentStats = computeAgentStats;
  readonly formatAgentStatsHuman = formatAgentStatsHuman;
}
