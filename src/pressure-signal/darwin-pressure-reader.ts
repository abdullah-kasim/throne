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
//   cpu     Utilisation over the one-second interval line of `iostat`. PSI cpu
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

import { execFileSync } from 'node:child_process';
import type { PsiReading } from './psi-pressure-reader.ts';

const UNKNOWN: PsiReading = { state: 'unknown', avg10: null, avg60: null };

export const DARWIN_IOSTAT_ARGUMENTS = ['-n', '0', '-c', '2', '-w', '1'] as const;

export function readIostatCpuWindow(): string {
  return execFileSync('iostat', [...DARWIN_IOSTAT_ARGUMENTS], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  });
}

export function parseDarwinIostatCpu(iostatOutput: string): PsiReading {
  const lines = iostatOutput.split('\n').map((line) => line.trim().split(/\s+/)).filter((fields) => fields[0] !== '');
  const headerIndex = lines.findIndex((fields) => fields[0] === 'us' && fields[1] === 'sy' && fields[2] === 'id');
  if (headerIndex < 0) return UNKNOWN;
  const samples = lines.slice(headerIndex + 1);
  if (samples.length < 2) return UNKNOWN;
  const idleField = samples[samples.length - 1]![2];
  if (idleField === undefined || !/^\d+$/.test(idleField)) return UNKNOWN;
  const idlePercent = Number(idleField);
  if (idlePercent > 100) return UNKNOWN;
  const busyPercent = 100 - idlePercent;
  return { state: 'ok', avg10: busyPercent, avg60: busyPercent };
}

export function readDarwinCpuPressure(readIostat: () => string = readIostatCpuWindow): PsiReading {
  try {
    return parseDarwinIostatCpu(readIostat());
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
    case 2:
      return 0;
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
