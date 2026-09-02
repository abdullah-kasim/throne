// `token-balance` -- render the token-lane load balancer's current verdict
// (which of SonnetLow/TerraLow new balanced-role spawns should land on, or
// why both are unusable) for a human or script asking "which lane is
// healthy right now?". Observe-and-report only: nothing here spawns,
// steers, or gates anything -- create-agent and alpha-autoscale each
// consult `scoreLanes` independently on their own dispatch path.

import { readFileSync } from 'node:fs';
import { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { USAGE_LOG_FILE } from '../plan-usage-remaining/telemetry-core/log.ts';
import type { UsageLogRow } from '../plan-usage-remaining/telemetry-core/log.ts';
import { computeUsageRates, type RateResult } from '../shared-policy/usagerate.ts';
import {
  scoreLanes,
  type LaneBalanceVerdict,
  type LaneUsageSnapshot,
  type LaneUsageWindow,
} from './token-balance-report.ts';

const MS_PER_HOUR = 3_600_000;

/** The two balanced lanes and the harness their usage log rows are keyed
 *  under. A third lane needs a new entry here, nowhere else -- the scoring
 *  module already treats `laneId` as opaque data. */
const LANES: ReadonlyArray<{ readonly laneId: string; readonly harness: string }> = [
  { laneId: 'SonnetLow', harness: 'claude' },
  { laneId: 'TerraLow', harness: 'codex' },
];

const FIVE_HOUR_CAP_WINDOW = '5h';
const WEEKLY_CAP_WINDOW = 'weekly';

export function readUsageLogRowsOrEmpty(): UsageLogRow[] {
  let raw: string;
  try {
    raw = readFileSync(USAGE_LOG_FILE, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as UsageLogRow];
      } catch {
        return [];
      }
    });
}

function latestRowFor(
  rows: readonly UsageLogRow[],
  harness: string,
  capWindow: string,
): UsageLogRow | undefined {
  return rows
    .filter((row) => row.harness === harness && row.cap_window === capWindow)
    .reduce<UsageLogRow | undefined>((latest, row) => {
      if (latest === undefined) return row;
      return Date.parse(row.recorded_at) > Date.parse(latest.recorded_at) ? row : latest;
    }, undefined);
}

/**
 * Builds one lane's usage window from its latest logged reading and its
 * computed burn rate, or `undefined` when there is no reading or no parsable
 * reset time to project against -- the caller degrades by omitting the lane
 * rather than scoring against a fabricated window.
 *
 * The burn rate prefers today's average (`RateResult.today.pct_per_hour`,
 * the more responsive of the two jitter-safe lookbacks `computeUsageRates`
 * already produces) and falls back to the trailing 7-day average when today
 * lacks enough history -- the same "insufficient data" fallback shape
 * `token-balance-report.ts` already applies to a wholly-absent rate.
 */
function laneUsageWindowFor(
  rows: readonly UsageLogRow[],
  rateResults: readonly RateResult[],
  harness: string,
  capWindow: string,
  anchorMs: number,
): LaneUsageWindow | undefined {
  const latestRow = latestRowFor(rows, harness, capWindow);
  if (latestRow === undefined || latestRow.reset_time === null) return undefined;
  const resetAtMs = Date.parse(latestRow.reset_time);
  if (!Number.isFinite(resetAtMs)) return undefined;

  const rate = rateResults.find(
    (result) => result.harness === harness && result.cap_window === capWindow,
  );
  const pctPerHour = rate?.today.pct_per_hour ?? rate?.seven_day.pct_per_hour ?? null;

  return {
    remainingPct: latestRow.remaining_pct,
    pctPerHour,
    hoursUntilReset: (resetAtMs - anchorMs) / MS_PER_HOUR,
  };
}

/** One lane's snapshot, or the reason it was left out of scoring. */
type LaneCollectionResult =
  | { readonly snapshot: LaneUsageSnapshot }
  | { readonly laneId: string; readonly missingReason: string };

/**
 * Collects both lanes' usage snapshots from the usage log, degrading a lane
 * with no readable 5h/weekly data to an omission rather than a thrown error
 * -- an absent lane still lets the other lane's data drive a verdict, same
 * discipline as `collectResourcePressureSnapshot`'s independent degradation.
 */
export function collectTokenBalanceLanes(rows: readonly UsageLogRow[]): LaneCollectionResult[] {
  const { anchor, results } = computeUsageRates([...rows]);
  const anchorMs = anchor === null ? Number.NaN : Date.parse(anchor);

  return LANES.map(({ laneId, harness }) => {
    if (!Number.isFinite(anchorMs)) {
      return { laneId, missingReason: 'no usage-log readings are available' };
    }
    const fiveHour = laneUsageWindowFor(rows, results, harness, FIVE_HOUR_CAP_WINDOW, anchorMs);
    const weekly = laneUsageWindowFor(rows, results, harness, WEEKLY_CAP_WINDOW, anchorMs);
    if (fiveHour === undefined || weekly === undefined) {
      return {
        laneId,
        missingReason: `no readable 5h/weekly usage-log reading for harness "${harness}"`,
      };
    }
    return { snapshot: { laneId, fiveHour, weekly } };
  });
}

function isSnapshotResult(
  result: LaneCollectionResult,
): result is { snapshot: LaneUsageSnapshot } {
  return 'snapshot' in result;
}

export interface TokenBalanceReport {
  readonly verdict: LaneBalanceVerdict;
  readonly excludedLanes: ReadonlyArray<{ readonly laneId: string; readonly reason: string }>;
}

export function collectTokenBalanceReport(rows: readonly UsageLogRow[]): TokenBalanceReport {
  const collected = collectTokenBalanceLanes(rows);
  const snapshots = collected.filter(isSnapshotResult).map((result) => result.snapshot);
  const excludedLanes = collected
    .filter((result): result is { laneId: string; missingReason: string } => !('snapshot' in result))
    .map((result) => ({ laneId: result.laneId, reason: result.missingReason }));
  return { verdict: scoreLanes(snapshots), excludedLanes };
}

export function tokenBalanceJson(report: TokenBalanceReport): object {
  return { verdict: report.verdict, excludedLanes: report.excludedLanes };
}

export function formatTokenBalanceReport(report: TokenBalanceReport): string[] {
  const lines: string[] = [];
  const { verdict } = report;
  if (verdict.blocked) {
    lines.push(`token-balance: blocked -- ${verdict.reason}`);
  } else {
    lines.push(`token-balance: chosen lane ${verdict.chosenLane}`);
  }
  for (const score of verdict.perLaneScores) {
    lines.push(
      `  ${score.laneId}: score ${score.score.toFixed(1)}%` +
        ` (5h projected ${score.projectedFiveHourRemainingPct.toFixed(1)}%,` +
        ` weekly projected ${score.projectedWeeklyRemainingPct.toFixed(1)}%)` +
        `${score.disqualified ? ' [disqualified]' : ''}`,
    );
  }
  for (const excluded of report.excludedLanes) {
    lines.push(`  ${excluded.laneId}: excluded -- ${excluded.reason}`);
  }
  return lines;
}

@Command({
  name: 'token-balance',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class TokenBalanceCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    const report = collectTokenBalanceReport(readUsageLogRowsOrEmpty());
    if (passedParams.includes('--json')) {
      process.stdout.write(`${JSON.stringify(tokenBalanceJson(report))}\n`);
    } else {
      for (const line of formatTokenBalanceReport(report)) {
        process.stdout.write(`${line}\n`);
      }
    }
    // Reporting succeeded even when a lane's data was partial or absent;
    // partiality is stated in the output, not converted into a failing exit.
    process.exitCode = 0;
  }
}
