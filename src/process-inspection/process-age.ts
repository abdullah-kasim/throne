import type { ProcessSnapshot } from './proc-scan.ts';

/**
 * Wall-clock age of a process in seconds, from its boot-relative
 * `startTicks` plus the machine's boot epoch. Returns `undefined` when the
 * boot time could not be read -- an unknown age must never silently become
 * a zero age, because zero reads as "brand new" and would exempt the exact
 * long-lived offender this exists to find.
 */
export function processAgeSeconds(
  snapshot: ProcessSnapshot,
  bootTimeEpochSeconds: number | undefined,
  nowEpochSeconds: number,
  clockTicksPerSecond: number,
): number | undefined {
  if (bootTimeEpochSeconds === undefined) return undefined;
  const startedAt = bootTimeEpochSeconds + snapshot.startTicks / clockTicksPerSecond;
  const age = nowEpochSeconds - startedAt;
  return age < 0 ? 0 : age;
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, '0')}m`;
  return `${minutes}m`;
}
