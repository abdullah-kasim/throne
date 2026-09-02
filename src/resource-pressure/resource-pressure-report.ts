// Pure assembly/formatting for the `resource-pressure` command. The verdict
// is NEVER computed here: it comes from the pressure-signal domain
// (`classifyPressure`, the Lord's standing 70 threshold) via
// `readCapacityPressure`, exactly the figure the alpha-autoscale admission
// gate and keep-going report already act on. Everything else in this report
// is supplemental telemetry for a human diagnosing WHY the box is (or is
// not) under pressure -- extra PSI windows, IO pressure, load vs cores,
// MemAvailable -- and deliberately has zero influence on the verdict, so
// this command can never disagree with the throne's own admission decisions.

import {
  AT_CAPACITY_THRESHOLD,
  IO_AT_CAPACITY_THRESHOLD,
  type PressureClassification,
} from '../pressure-signal/classify-pressure.ts';
import { DARWIN_IO_UNMEASURABLE_NOTE } from '../pressure-signal/darwin-pressure-reader.ts';

/** Where the verdict's inputs came from: Linux PSI files, or the darwin
 *  readers (cpu utilisation sample, kernel memorystatus, io unmeasurable). */
export type ResourcePressureSource = 'psi' | 'darwin';

/**
 * One `/proc/pressure/*` "some" line widened to all three kernel windows.
 * The pressure-signal domain's `PsiReading` intentionally carries only
 * avg10/avg60 (the verdict inputs); avg300 is display-only context, so it is
 * parsed here rather than widening the domain type every consumer shares.
 */
export interface PsiWindows {
  readonly avg10: number;
  readonly avg60: number;
  readonly avg300: number;
}

export interface ResourcePressureSnapshot {
  readonly source: ResourcePressureSource;
  readonly classification: PressureClassification;
  readonly cpu: PsiWindows | null;
  readonly memory: PsiWindows | null;
  readonly io: PsiWindows | null;
  readonly loadAverages: readonly [number, number, number];
  readonly cpuCount: number;
  readonly memTotalKib: number | null;
  readonly memAvailableKib: number | null;
}

const SOME_ALL_WINDOWS_PATTERN =
  /^some\s.*\bavg10=([0-9]+(?:\.[0-9]+)?)\b.*\bavg60=([0-9]+(?:\.[0-9]+)?)\b.*\bavg300=([0-9]+(?:\.[0-9]+)?)\b/m;

/** Parses a raw PSI file body's `some` line into all three windows, or null. */
export function parsePsiWindows(content: string): PsiWindows | null {
  const match = SOME_ALL_WINDOWS_PATTERN.exec(content);
  if (!match) return null;
  const [avg10, avg60, avg300] = [match[1], match[2], match[3]].map(Number);
  if (![avg10, avg60, avg300].every(Number.isFinite)) return null;
  return { avg10, avg60, avg300 };
}

/** Extracts MemTotal/MemAvailable (KiB) from a /proc/meminfo body. */
export function parseMeminfoKib(content: string): {
  memTotalKib: number | null;
  memAvailableKib: number | null;
} {
  const grab = (field: string): number | null => {
    const match = new RegExp(`^${field}:\\s+(\\d+)\\s*kB`, 'm').exec(content);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  };
  return { memTotalKib: grab('MemTotal'), memAvailableKib: grab('MemAvailable') };
}

function formatWindows(label: string, windows: PsiWindows | null): string {
  if (windows === null) return `  ${label} PSI some: unavailable`;
  return `  ${label} PSI some: avg10 ${windows.avg10.toFixed(1)}  avg60 ${windows.avg60.toFixed(1)}  avg300 ${windows.avg300.toFixed(1)}`;
}

function formatGib(kib: number): string {
  return `${(kib / (1024 * 1024)).toFixed(1)} GiB`;
}

/**
 * Renders the snapshot as the command's human report. The first line is the
 * verdict line and always states the domain figure, verdict, and threshold;
 * an `unknown` verdict is stated as unknown, never defaulted (mirroring the
 * keep-going report's fail-closed rendering).
 */
export function formatResourcePressureReport(
  snapshot: ResourcePressureSnapshot,
): string[] {
  const { classification } = snapshot;
  const lines: string[] = [];
  if (classification.verdict === 'unknown') {
    lines.push(
      `resource-pressure: unknown -- ${classification.reasons.join('; ')}`,
    );
  } else {
    // TWO thresholds, deliberately: the figure carries what 70 governs
    // (cpu/memory PSI and load-per-core x100), while io-full is graded at its
    // own higher 90. Putting a 90-graded term inside a 70-graded number
    // rendered as "75.05 -- take-more-work", which reads as a bug. The verdict
    // inputs are printed beneath because max() hides which signal won.
    lines.push(
      `resource-pressure: ${classification.pressure?.toFixed(2)} -- ${classification.verdict} ` +
        `(threshold ${AT_CAPACITY_THRESHOLD} on cpu/memory avg10+avg60 and load-per-core x100; ` +
        `io-full graded separately at ${IO_AT_CAPACITY_THRESHOLD})`,
    );
    for (const reason of classification.reasons) {
      lines.push(`  verdict input: ${reason}`);
    }
  }
  if (snapshot.source === 'darwin') {
    // No PSI windows exist to print; say what the verdict was graded from
    // instead of rendering three "unavailable" lines that read as a fault.
    lines.push(
      '  source: darwin -- cpu is utilisation over a 500 ms sample, memory is kernel memorystatus (100 - free%, floored by the pressure level)',
    );
    lines.push(`  io: ${DARWIN_IO_UNMEASURABLE_NOTE}`);
  } else {
    lines.push(formatWindows('cpu', snapshot.cpu));
    lines.push(formatWindows('memory', snapshot.memory));
    lines.push(
      `${formatWindows('io', snapshot.io)}  [some shown; the verdict grades io FULL at ${IO_AT_CAPACITY_THRESHOLD}]`,
    );
  }
  const [load1, load5, load15] = snapshot.loadAverages;
  const perCore =
    snapshot.cpuCount > 0 ? ` (${(load1 / snapshot.cpuCount).toFixed(1)}x per core)` : '';
  lines.push(
    `  load: ${load1.toFixed(2)} / ${load5.toFixed(2)} / ${load15.toFixed(2)} on ${snapshot.cpuCount} cpus${perCore}`,
  );
  if (snapshot.memTotalKib !== null && snapshot.memAvailableKib !== null) {
    lines.push(
      `  memory: ${formatGib(snapshot.memAvailableKib)} available of ${formatGib(snapshot.memTotalKib)}`,
    );
  } else {
    lines.push('  memory: meminfo unavailable');
  }
  return lines;
}

/** JSON projection for `--json`: the same snapshot, no derived opinions. */
export function resourcePressureJson(snapshot: ResourcePressureSnapshot): object {
  return {
    source: snapshot.source,
    verdict: snapshot.classification.verdict,
    pressure: snapshot.classification.pressure,
    threshold: AT_CAPACITY_THRESHOLD,
    reasons: snapshot.classification.reasons,
    psi: { cpu: snapshot.cpu, memory: snapshot.memory, io: snapshot.io },
    load: {
      avg1: snapshot.loadAverages[0],
      avg5: snapshot.loadAverages[1],
      avg15: snapshot.loadAverages[2],
      cpuCount: snapshot.cpuCount,
    },
    memoryKib: {
      total: snapshot.memTotalKib,
      available: snapshot.memAvailableKib,
    },
  };
}
