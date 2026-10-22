// Observe-and-report only: reads the current capacity pressure figure and
// renders it as one more line of keep-going's existing per-tick report.
// This module has zero authority to launch or affect any agent -- it reads
// the host's pressure sources and produces text. No spawn action is
// reachable from here (proven structurally by
// keep-going-pressure-report-no-spawn-path.test.ts).
//
// Two hosts, one classifier: Linux reads `/proc/pressure/{cpu,memory}` (PSI)
// and the physical disks' busy time from `/proc/diskstats`; macOS,
// which has no PSI, reads the darwin sources in
// `pressure-signal/darwin-pressure-reader.ts`. Both feed the SAME
// `classifyPressure` with the same thresholds, so the alpha-autoscale gate,
// keep-going's report and `resource-pressure` agree on every platform.

import { availableParallelism, loadavg } from 'node:os';
import { readPsiPressure } from '../pressure-signal/psi-pressure-reader.ts';
import {
  readLinuxDiskBusyPressure,
  type DiskBusySources,
} from '../pressure-signal/linux-disk-busy-reader.ts';
import {
  readDarwinCpuPressure,
  readDarwinIoPressure,
  readDarwinMemoryPressure,
  type CpuTimesSample,
} from '../pressure-signal/darwin-pressure-reader.ts';
import {
  LOAD_GRADED_IN_PRESSURE_FIGURE,
  classifyPressure,
  loadGradedAgainstItsOwnLimit,
  type LoadReading,
  type PressureClassification,
} from '../pressure-signal/classify-pressure.ts';
import { macLoadPerCoreAtCapacity } from '../steering-user-config.ts';

const CPU_PRESSURE_PATH = '/proc/pressure/cpu';
const MEMORY_PRESSURE_PATH = '/proc/pressure/memory';

/**
 * The live 1-minute run queue against usable cores, for the oversubscription
 * half of the verdict. `loadavg()` returns `[0,0,0]` on platforms with no load
 * concept, which is indistinguishable from a genuinely idle box — so a
 * non-positive core count is the only unreadable case, and it is reported as
 * `unknown` rather than silently admitting work.
 */
export function readLoadReading(): LoadReading {
  const cpuCount = availableParallelism();
  if (!Number.isFinite(cpuCount) || cpuCount <= 0) return { state: 'unknown' };
  const [load1] = loadavg();
  if (!Number.isFinite(load1)) return { state: 'unknown' };
  return { state: 'ok', load1, cpuCount };
}

export interface CapacityPressureSources {
  readonly platform: NodeJS.Platform;
  readonly cpuPath: string;
  readonly memoryPath: string;
  readonly load: LoadReading;
  readonly disk: DiskBusySources;
  readonly macLoadLimitPerCore: number;
  readonly sampleDarwinCpus: () => CpuTimesSample;
  readonly sleepDuringDarwinCpuSample: (milliseconds: number) => void;
  readonly readDarwinSysctl: (names: readonly string[]) => string;
}

/**
 * Reads and classifies the current capacity pressure from the host's live
 * sources plus the run queue. On Linux that is `/proc/pressure/{cpu,memory}`
 * plus the busiest physical disk's busy time over a `/proc/diskstats` sample;
 * on darwin it is the readers in `darwin-pressure-reader.ts`, because macOS has
 * no PSI and the Linux path there produced a permanent `unknown` that never
 * spawned an Alpha (measured 2026-09-02). Every source is overridable only so
 * tests can supply fixtures; production always calls this with no arguments.
 */
export function readCapacityPressure(
  fixtures: Partial<CapacityPressureSources> = {},
): PressureClassification {
  const load = fixtures.load ?? readLoadReading();
  if ((fixtures.platform ?? process.platform) === 'darwin') {
    return classifyPressure(
      readDarwinCpuPressure(fixtures.sampleDarwinCpus, fixtures.sleepDuringDarwinCpuSample),
      readDarwinMemoryPressure(fixtures.readDarwinSysctl),
      load,
      readDarwinIoPressure(),
      loadGradedAgainstItsOwnLimit(fixtures.macLoadLimitPerCore ?? macLoadPerCoreAtCapacity()),
    );
  }
  return classifyPressure(
    readPsiPressure(fixtures.cpuPath ?? CPU_PRESSURE_PATH),
    readPsiPressure(fixtures.memoryPath ?? MEMORY_PRESSURE_PATH),
    load,
    readLinuxDiskBusyPressure(fixtures.disk),
    LOAD_GRADED_IN_PRESSURE_FIGURE,
  );
}

/**
 * Renders one classified pressure reading as a keep-going report line.
 * Pure formatting -- an `unknown` verdict is stated as "pressure unknown",
 * never defaulted into either take-more-work or at-capacity.
 */
export function formatCapacityPressureReportLine(
  classification: PressureClassification,
): string {
  if (classification.verdict === 'unknown') {
    return 'keep-going: capacity pressure unknown -- cannot state a take-more-work verdict.\n';
  }
  const verdictText =
    classification.verdict === 'take-more-work'
      ? 'can take more work'
      : 'at capacity, cannot take more work';
  const reportLine = `keep-going: capacity pressure ${classification.pressure} -- ${verdictText}.\n`;
  if (classification.verdict !== 'take-more-work') {
    return reportLine;
  }
  return `${reportLine}keep-going: capacity headroom is available -- this says nothing about same-file conflicts between campaigns.\n`;
}
