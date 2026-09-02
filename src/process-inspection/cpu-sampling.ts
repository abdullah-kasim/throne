import {
  DEFAULT_CLOCK_TICKS_PER_SECOND,
  DEFAULT_PROC_ROOT,
  listProcessSnapshots,
  type ProcessSnapshot,
} from './proc-scan.ts';

/** Milliseconds between the two `/proc` reads a CPU delta is measured over.
 *  Long enough that clock-tick quantisation (10ms granularity) is noise
 *  rather than signal, short enough that an hourly tick does not visibly
 *  linger. */
export const DEFAULT_CPU_SAMPLE_INTERVAL_MS = 3_000;

/**
 * Whether a process moved FORWARD between the two samples — the actual
 * discriminator, per the Lord's ruling that magnitude is not one. A spinner
 * measured on this box burned 206 CPU ticks over 3 seconds with syscall
 * deltas of exactly 0 and 0; a live `tsc` compile over the same window did
 * 68 reads and 4 writes. CPU alone cannot tell those apart.
 *
 * `unknown` is its own value and never collapses into `stalled`: an
 * unreadable `/proc/<pid>/io` (a foreign-owner process, or one that exited
 * mid-sample) is missing evidence, and reading missing evidence as "made no
 * progress" would flag every process this user cannot inspect.
 */
export type ProgressVerdict = 'advanced' | 'stalled' | 'unknown';

export interface SampledProcess {
  /** The second read's snapshot: the process as it exists now. */
  snapshot: ProcessSnapshot;
  /** Cores' worth of CPU consumed between the two reads. 1.0 is exactly one
   *  saturated core. This is the CURRENT rate -- never the lifetime `%CPU`
   *  figure `ps` prints, which reads high for a process that thrashed once
   *  days ago and has idled ever since, and reads high for healthy
   *  long-lived servers (herdr at 15.6% over 6.7 days). */
  cpuFraction: number;
  /** Cores' worth of CPU, per CORE and never per machine. One fully stuck
   *  process is 100% of a core but only 8% of this 12-core box; a
   *  capacity-share threshold would have missed the 55-hour orphan that
   *  caused this objective. Nothing here divides by core count. */
  progress: ProgressVerdict;
  elapsedMs: number;
}

export function compareProgress(
  before: ProcessSnapshot,
  after: ProcessSnapshot,
): ProgressVerdict {
  if (before.ioSyscalls === undefined || after.ioSyscalls === undefined) return 'unknown';
  if (
    after.ioSyscalls.reads !== before.ioSyscalls.reads ||
    after.ioSyscalls.writes !== before.ioSyscalls.writes
  ) {
    return 'advanced';
  }
  // VmRSS is the independent second signal: pure in-memory work issues no
  // syscalls but still moves the resident set. Its absence (a kernel thread
  // has none) is not evidence of stalling on its own — the syscall counters
  // above already agreed, so an unknown RSS leaves that verdict standing.
  if (
    before.vmRssKb !== undefined &&
    after.vmRssKb !== undefined &&
    before.vmRssKb !== after.vmRssKb
  ) {
    return 'advanced';
  }
  return 'stalled';
}

export interface CpuSampleDeps {
  listSnapshots: () => Promise<ProcessSnapshot[]>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  clockTicksPerSecond: number;
  intervalMs: number;
}

export const REAL_CPU_SAMPLE_DEPS: CpuSampleDeps = {
  listSnapshots: () => listProcessSnapshots(DEFAULT_PROC_ROOT),
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  clockTicksPerSecond: DEFAULT_CLOCK_TICKS_PER_SECOND,
  intervalMs: DEFAULT_CPU_SAMPLE_INTERVAL_MS,
};

/**
 * Two process-table reads separated by `intervalMs`, reduced to a per-process
 * CPU rate. Only processes present in BOTH reads are returned: a process that
 * appeared in between has no baseline to subtract, and inventing one would
 * report a brand-new process as having burned its entire lifetime CPU inside
 * the sample window. A pid whose `startTicks` changed between reads is a
 * RECYCLED pid, not the same process, and is dropped for the same reason.
 */
export async function sampleProcessCpu(
  deps: CpuSampleDeps = REAL_CPU_SAMPLE_DEPS,
): Promise<SampledProcess[]> {
  const firstAtMs = deps.now();
  const first = await deps.listSnapshots();
  await deps.sleep(deps.intervalMs);
  const second = await deps.listSnapshots();
  const elapsedMs = deps.now() - firstAtMs;
  if (elapsedMs <= 0) return [];
  const baseline = new Map(first.map((snapshot) => [snapshot.pid, snapshot]));
  return second.flatMap((snapshot) => {
    const previous = baseline.get(snapshot.pid);
    if (previous === undefined) return [];
    if (previous.startTicks !== snapshot.startTicks) return [];
    const ticks = snapshot.cpuTicks - previous.cpuTicks;
    if (ticks < 0) return [];
    const cpuSeconds = ticks / deps.clockTicksPerSecond;
    return [
      {
        snapshot,
        cpuFraction: cpuSeconds / (elapsedMs / 1_000),
        progress: compareProgress(previous, snapshot),
        elapsedMs,
      },
    ];
  });
}
