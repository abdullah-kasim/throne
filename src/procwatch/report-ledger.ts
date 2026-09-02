import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { RUNTIME_DATA_DIR } from '../shared-policy/runtime-data-home.ts';
import type { ProcessRecord } from './detect.ts';

/** How long an already-reported offender stays silent before it is named
 *  again. Reporting the same pid every hour teaches the Regent to ignore the
 *  channel, which defeats the whole mechanism; staying silent forever loses
 *  a process that outlived its first report. Six hours is the escalation
 *  interval, not the detection interval. */
export const REPORT_ESCALATION_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export interface ReportLedgerEntry {
  readonly firstReportedAtMs: number;
  readonly lastReportedAtMs: number;
  readonly reportCount: number;
}

export type ReportLedger = Record<string, ReportLedgerEntry>;

export function procwatchLedgerPath(dataDir: string = RUNTIME_DATA_DIR): string {
  return path.join(dataDir, 'regent', 'procwatch-reports.json');
}

/** Process identity that survives pid recycling: a bare pid does not. */
export function offenderKey(offender: Pick<ProcessRecord, 'pid' | 'startTicks'>): string {
  return `${offender.pid}:${offender.startTicks}`;
}

export async function readReportLedger(ledgerPath: string): Promise<ReportLedger> {
  let bytes: string;
  try {
    bytes = await readFile(ledgerPath, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(bytes) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as ReportLedger;
  } catch {
    // A malformed ledger costs one duplicate report, never a missed one.
    return {};
  }
}

export async function writeReportLedger(
  ledgerPath: string,
  ledger: ReportLedger,
): Promise<void> {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const staging = `${ledgerPath}.${randomUUID()}.tmp`;
  await writeFile(staging, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await rename(staging, ledgerPath);
}

export interface ReportSelection<T> {
  readonly report: T[];
  readonly escalations: ReadonlySet<string>;
  readonly nextLedger: ReportLedger;
}

/**
 * Report each offender ONCE, then escalate rather than nag. An offender not
 * in the ledger is reported and recorded; one already recorded is silent
 * until `REPORT_ESCALATION_INTERVAL_MS` has passed, at which point it is
 * re-reported AS an escalation ("still alive N hours later"), which is the
 * genuinely new fact.
 *
 * Entries for offenders absent from this tick are dropped: the process is
 * gone (or fell below threshold), so a later recurrence is a fresh incident
 * and deserves a fresh first report, not a stale escalation counter.
 */
export function selectToReport<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  ledger: ReportLedger,
  nowMs: number,
): ReportSelection<T> {
  const report: T[] = [];
  const escalations = new Set<string>();
  const nextLedger: ReportLedger = {};
  for (const offender of items) {
    const key = keyOf(offender);
    const previous = ledger[key];
    if (previous === undefined) {
      report.push(offender);
      nextLedger[key] = { firstReportedAtMs: nowMs, lastReportedAtMs: nowMs, reportCount: 1 };
      continue;
    }
    if (nowMs - previous.lastReportedAtMs >= REPORT_ESCALATION_INTERVAL_MS) {
      report.push(offender);
      escalations.add(key);
      nextLedger[key] = {
        firstReportedAtMs: previous.firstReportedAtMs,
        lastReportedAtMs: nowMs,
        reportCount: previous.reportCount + 1,
      };
      continue;
    }
    nextLedger[key] = previous;
  }
  return { report, escalations, nextLedger };
}

export function selectOffendersToReport<T extends Pick<ProcessRecord, 'pid' | 'startTicks'>>(
  offenders: readonly T[],
  ledger: ReportLedger,
  nowMs: number,
): ReportSelection<T> {
  return selectToReport(offenders, offenderKey, ledger, nowMs);
}

/** Aged suite containers share the offenders' ledger and its report-once
 *  discipline, under a namespaced key so a container name can never collide
 *  with a `pid:starttime` one. A container's name IS its identity — podman
 *  never reuses one while the old container exists. */
export function containerKey(name: string): string {
  return `container:${name}`;
}
