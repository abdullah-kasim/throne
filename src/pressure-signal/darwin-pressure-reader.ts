// macOS capacity-pressure sources, shaped as `PsiReading`s so `classifyPressure`
// grades them with the SAME thresholds and the same merged figure as Linux PSI.
//
// WHY THIS EXISTS. The Lord's order of 2026-09-02: "autoscaler needs to support
// mac as well." Measured that day on the live Mac (throne-backend.log): every
// alpha-autoscale tick logged `floor breach: live=0 floor=4` followed by
// `skip: pressure verdict is "unknown"`, because the only pressure sources were
// `/proc/pressure/{cpu,memory,io}`, which macOS does not have. The gate failed
// closed, exactly as designed for an unreadable Linux box -- and so never
// spawned a single Alpha on this host.
//
// macOS has no PSI. Each term below is the nearest thing the kernel actually
// measures, and each one is honest about what it is:
//
//   cpu     Utilisation over a short sample of `os.cpus()` tick deltas. PSI cpu
//           `some` is the share of time a runnable task waited for a core;
//           utilisation is the share of time cores were busy. They agree at the
//           extremes (an idle box reads ~0 on both, a saturated box reads ~100
//           on both) and the run-queue oversubscription term already in the
//           merged figure covers the middle -- a box at 0.7x per core is
//           refused by the load term long before utilisation alone would say
//           so. One sample yields one number, so avg10 and avg60 are the same
//           value here; the classifier takes max() of the two anyway.
//
//   memory  The kernel's OWN memory-pressure subsystem (memorystatus), which is
//           the macOS analogue of memory PSI:
//             kern.memorystatus_level              = system-wide free %, the
//                                                    same figure
//                                                    `memory_pressure` prints
//             kern.memorystatus_vm_pressure_level  = 1 normal, 2 warn,
//                                                    4 critical
//           pressure = max(100 - free%, floor(level)), where warn pins the
//           reading to AT_CAPACITY_THRESHOLD and critical to 100. So the
//           kernel declaring warn refuses admission by itself, regardless of
//           what the free percentage says, and a quiet free% cannot mask it.
//
//   io      macOS exposes NO stall telemetry -- `iostat` reports throughput,
//           not waiting, and there is no D-state count. This term is graded
//           as 0 and SAID SO in the reading's provenance. Reporting it
//           `unknown` instead would be the fail-closed choice the Linux path
//           makes for an unreadable /proc, but here it would refuse every
//           spawn on every Mac forever, which is the exact state the Lord
//           ordered fixed. io is graded at its own 90 threshold and exists to
//           catch a box that cannot make progress on disk; on this host that
//           blind spot is accepted and documented, not hidden.
//
// Every reader takes its host calls as parameters so tests drive them with
// fixtures; production calls them with no arguments.

import { cpus as osCpus } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { PsiReading } from './psi-pressure-reader.ts';
import { AT_CAPACITY_THRESHOLD } from './classify-pressure.ts';

const UNKNOWN: PsiReading = { state: 'unknown', avg10: null, avg60: null };

/** How long the cpu sample runs. Long enough for the tick counters to move on
 *  an idle box (macOS updates them at 100 Hz), short enough that a 5-minute
 *  cron tick and a one-shot `resource-pressure` both barely notice. */
export const DARWIN_CPU_SAMPLE_MS = 500;

export type CpuTimesSample = ReadonlyArray<{
  readonly times: Readonly<Record<string, number>>;
}>;

/** Synchronous sleep: the pressure readers are called from synchronous
 *  dependency seams (`readPressure: () => PressureClassification`), so the
 *  sample window cannot await. `Atomics.wait` blocks without spinning. */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Utilisation percentage between two `os.cpus()` samples: 100 x (1 - idle /
 * total) summed across every core. `unknown` when the samples disagree on
 * core count, are empty, or no ticks elapsed (a zero-length window has no
 * utilisation, and 0/0 must not read as idle).
 */
export function utilisationBetween(
  before: CpuTimesSample,
  after: CpuTimesSample,
): PsiReading {
  if (before.length === 0 || before.length !== after.length) return UNKNOWN;
  let idle = 0;
  let total = 0;
  for (let index = 0; index < before.length; index += 1) {
    const earlier = before[index]!.times;
    const later = after[index]!.times;
    for (const key of Object.keys(later)) {
      const delta = (later[key] ?? 0) - (earlier[key] ?? 0);
      if (!Number.isFinite(delta) || delta < 0) return UNKNOWN;
      total += delta;
      if (key === 'idle') idle += delta;
    }
  }
  if (total <= 0) return UNKNOWN;
  const utilisation = 100 * (1 - idle / total);
  const clamped = Math.min(100, Math.max(0, utilisation));
  return { state: 'ok', avg10: clamped, avg60: clamped };
}

/** The cpu term: utilisation over one `sampleMs` window. */
export function readDarwinCpuPressure(
  sampleCpus: () => CpuTimesSample = osCpus,
  sleep: (milliseconds: number) => void = sleepSync,
  sampleMs: number = DARWIN_CPU_SAMPLE_MS,
): PsiReading {
  try {
    const before = sampleCpus();
    sleep(sampleMs);
    const after = sampleCpus();
    return utilisationBetween(before, after);
  } catch {
    return UNKNOWN;
  }
}

/** `sysctl -n <name>...` output, one value per line, in argument order. */
export function readSysctlValues(names: readonly string[]): string {
  return execFileSync('sysctl', ['-n', ...names], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  });
}

/** The memorystatus pressure level's floor on the merged reading. Any level
 *  the kernel has not documented is `null` -> the reading is `unknown`. */
export function memorystatusLevelFloor(level: number): number | null {
  switch (level) {
    case 1:
      return 0; // normal
    case 2:
      return AT_CAPACITY_THRESHOLD; // warn: the kernel itself says stop
    case 4:
      return 100; // critical
    default:
      return null;
  }
}

/**
 * The memory term from `kern.memorystatus_level` (free %) and
 * `kern.memorystatus_vm_pressure_level`, parsed from the two-line sysctl
 * output. Never throws; anything malformed is `unknown`, never a default.
 */
export function parseDarwinMemoryPressure(sysctlOutput: string): PsiReading {
  const lines = sysctlOutput.trim().split('\n');
  if (lines.length !== 2) return UNKNOWN;
  const freePercent = Number(lines[0]!.trim());
  const level = Number(lines[1]!.trim());
  if (!Number.isFinite(freePercent) || freePercent < 0 || freePercent > 100) return UNKNOWN;
  if (!Number.isInteger(level)) return UNKNOWN;
  const floor = memorystatusLevelFloor(level);
  if (floor === null) return UNKNOWN;
  const pressure = Math.max(100 - freePercent, floor);
  return { state: 'ok', avg10: pressure, avg60: pressure };
}

export const DARWIN_MEMORY_SYSCTLS = [
  'kern.memorystatus_level',
  'kern.memorystatus_vm_pressure_level',
] as const;

export function readDarwinMemoryPressure(
  sysctl: (names: readonly string[]) => string = readSysctlValues,
): PsiReading {
  try {
    return parseDarwinMemoryPressure(sysctl(DARWIN_MEMORY_SYSCTLS));
  } catch {
    return UNKNOWN;
  }
}

/** See the file header: macOS has no io stall telemetry. This is a measured
 *  absence graded as 0, not a failed read -- a failed read is `unknown` and
 *  would refuse every spawn on every Mac. */
export const DARWIN_IO_UNMEASURABLE_NOTE =
  'io stall is not measurable on darwin (no PSI, no D-state count); graded as 0 by the Lord\'s order of 2026-09-02';

export function readDarwinIoPressure(): PsiReading {
  return { state: 'ok', avg10: 0, avg60: 0 };
}

/** Free memory as macOS reports it (`kern.memorystatus_level` is a percentage
 *  of `hw.memsize`), in KiB, for the `resource-pressure` report's memory line.
 *  Display-only; the verdict never reads this. */
export function parseDarwinMemoryKib(sysctlOutput: string): {
  memTotalKib: number | null;
  memAvailableKib: number | null;
} {
  const lines = sysctlOutput.trim().split('\n');
  if (lines.length !== 2) return { memTotalKib: null, memAvailableKib: null };
  const memsizeBytes = Number(lines[0]!.trim());
  const freePercent = Number(lines[1]!.trim());
  if (!Number.isFinite(memsizeBytes) || memsizeBytes <= 0) {
    return { memTotalKib: null, memAvailableKib: null };
  }
  const memTotalKib = Math.round(memsizeBytes / 1024);
  if (!Number.isFinite(freePercent) || freePercent < 0 || freePercent > 100) {
    return { memTotalKib, memAvailableKib: null };
  }
  return { memTotalKib, memAvailableKib: Math.round((memTotalKib * freePercent) / 100) };
}

export const DARWIN_MEMORY_KIB_SYSCTLS = ['hw.memsize', 'kern.memorystatus_level'] as const;

export function readDarwinMemoryKib(
  sysctl: (names: readonly string[]) => string = readSysctlValues,
): { memTotalKib: number | null; memAvailableKib: number | null } {
  try {
    return parseDarwinMemoryKib(sysctl(DARWIN_MEMORY_KIB_SYSCTLS));
  } catch {
    return { memTotalKib: null, memAvailableKib: null };
  }
}
