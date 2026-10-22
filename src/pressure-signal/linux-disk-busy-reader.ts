import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { UNKNOWN_PSI_READING, type PsiReading } from './psi-pressure-reader.ts';
import { sleepSync } from './synchronous-sleep.ts';

export const DISK_BUSY_SAMPLE_MS = 1000;
export const DISKSTATS_PATH = '/proc/diskstats';
export const SYS_BLOCK_ROOT = '/sys/block';

const DEVICE_NAME_FIELD_INDEX = 2;
const IO_TICKS_FIELD_INDEX = 12;

export type BusyMillisecondsByDisk = ReadonlyMap<string, number>;

export interface DiskBusySources {
  readonly diskstatsPath: string;
  readonly sysBlockRoot: string;
  readonly sleep: (milliseconds: number) => void;
  readonly now: () => number;
}

export const LIVE_DISK_BUSY_SOURCES: DiskBusySources = {
  diskstatsPath: DISKSTATS_PATH,
  sysBlockRoot: SYS_BLOCK_ROOT,
  sleep: sleepSync,
  now: () => performance.now(),
};

export function isPhysicalDisk(sysBlockRoot: string, deviceName: string): boolean {
  return existsSync(join(sysBlockRoot, deviceName, 'device'));
}

export function physicalDiskBusyMilliseconds(
  diskstats: string,
  sysBlockRoot: string,
): BusyMillisecondsByDisk {
  const busyMillisecondsByDisk = new Map<string, number>();
  for (const row of diskstats.split('\n')) {
    const fields = row.trim().split(/\s+/);
    if (fields.length <= IO_TICKS_FIELD_INDEX) continue;
    const deviceName = fields[DEVICE_NAME_FIELD_INDEX]!;
    if (!isPhysicalDisk(sysBlockRoot, deviceName)) continue;
    busyMillisecondsByDisk.set(deviceName, Number(fields[IO_TICKS_FIELD_INDEX]));
  }
  return busyMillisecondsByDisk;
}

export function busiestDiskBetween(
  before: BusyMillisecondsByDisk,
  after: BusyMillisecondsByDisk,
  elapsedMilliseconds: number,
): PsiReading {
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds <= 0) return UNKNOWN_PSI_READING;
  let busiestPercent: number | null = null;
  for (const [deviceName, laterBusyMilliseconds] of after) {
    const earlierBusyMilliseconds = before.get(deviceName);
    if (earlierBusyMilliseconds === undefined) continue;
    const busyDelta = laterBusyMilliseconds - earlierBusyMilliseconds;
    if (!Number.isFinite(busyDelta) || busyDelta < 0) return UNKNOWN_PSI_READING;
    const busyPercent = Math.min(100, Math.max(0, (100 * busyDelta) / elapsedMilliseconds));
    busiestPercent = Math.max(busiestPercent ?? 0, busyPercent);
  }
  if (busiestPercent === null) return UNKNOWN_PSI_READING;
  return { state: 'ok', avg10: busiestPercent, avg60: busiestPercent };
}

export function readLinuxDiskBusyPressure(
  sources: DiskBusySources = LIVE_DISK_BUSY_SOURCES,
  sampleMilliseconds: number = DISK_BUSY_SAMPLE_MS,
): PsiReading {
  const sampleBusyMilliseconds = (): BusyMillisecondsByDisk =>
    physicalDiskBusyMilliseconds(readFileSync(sources.diskstatsPath, 'utf8'), sources.sysBlockRoot);
  try {
    const before = sampleBusyMilliseconds();
    const startedAt = sources.now();
    sources.sleep(sampleMilliseconds);
    const after = sampleBusyMilliseconds();
    const finishedAt = sources.now();
    return busiestDiskBetween(before, after, finishedAt - startedAt);
  } catch {
    return UNKNOWN_PSI_READING;
  }
}
