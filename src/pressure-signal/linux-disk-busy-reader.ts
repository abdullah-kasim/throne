import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { UNKNOWN_PSI_READING, type PsiReading } from './psi-pressure-reader.ts';
import { sleepSync } from './synchronous-sleep.ts';

export const DISK_BUSY_SAMPLE_MS = 1000;
export const DISKSTATS_PATH = '/proc/diskstats';
export const SYS_BLOCK_ROOT = '/sys/block';
export const MOUNTINFO_PATH = '/proc/self/mountinfo';
export const SYS_FS_BTRFS_ROOT = '/sys/fs/btrfs';

const DEVICE_NAME_FIELD_INDEX = 2;
const IO_TICKS_FIELD_INDEX = 12;
const MOUNT_POINT_FIELD_INDEX = 4;
const MOUNTINFO_OPTIONAL_FIELDS_END = '-';
const SOURCE_FIELDS_AFTER_OPTIONAL_FIELDS_END = 2;

export type BusyMillisecondsByDisk = ReadonlyMap<string, number>;

export interface DiskBusySources {
  readonly diskstatsPath: string;
  readonly sysBlockRoot: string;
  readonly homePath: string;
  readonly mountinfoPath: string;
  readonly sysFsBtrfsRoot: string;
  readonly sleep: (milliseconds: number) => void;
  readonly now: () => number;
}

export const LIVE_DISK_BUSY_SOURCES: DiskBusySources = {
  diskstatsPath: DISKSTATS_PATH,
  sysBlockRoot: SYS_BLOCK_ROOT,
  homePath: homedir(),
  mountinfoPath: MOUNTINFO_PATH,
  sysFsBtrfsRoot: SYS_FS_BTRFS_ROOT,
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

function unescapeMountinfoField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function isPathUnder(path: string, mountPoint: string): boolean {
  return path === mountPoint || path.startsWith(mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`);
}

function homeMountSource(mountinfo: string, realHomePath: string): string | undefined {
  let longestMountPoint = '';
  let source: string | undefined;
  for (const row of mountinfo.split('\n')) {
    const fields = row.trim().split(' ');
    const optionalFieldsEnd = fields.indexOf(MOUNTINFO_OPTIONAL_FIELDS_END);
    const sourceField = fields[optionalFieldsEnd + SOURCE_FIELDS_AFTER_OPTIONAL_FIELDS_END];
    if (optionalFieldsEnd <= MOUNT_POINT_FIELD_INDEX || sourceField === undefined) continue;
    const mountPoint = unescapeMountinfoField(fields[MOUNT_POINT_FIELD_INDEX]!);
    if (!isPathUnder(realHomePath, mountPoint) || mountPoint.length < longestMountPoint.length) continue;
    longestMountPoint = mountPoint;
    source = unescapeMountinfoField(sourceField);
  }
  return source;
}

function deviceMapperName(sysBlockRoot: string, deviceName: string): string | undefined {
  const namePath = join(sysBlockRoot, deviceName, 'dm', 'name');
  return existsSync(namePath) ? readFileSync(namePath, 'utf8').trim() : undefined;
}

function blockDeviceNamed(sysBlockRoot: string, source: string): string {
  const sourceName = basename(source);
  const mappedDevice = readdirSync(sysBlockRoot).find(
    (deviceName) => deviceMapperName(sysBlockRoot, deviceName) === sourceName,
  );
  return mappedDevice ?? sourceName;
}

function btrfsMemberDevices(sysFsBtrfsRoot: string, deviceName: string): readonly string[] {
  if (!existsSync(sysFsBtrfsRoot)) return [deviceName];
  for (const filesystem of readdirSync(sysFsBtrfsRoot)) {
    const devicesPath = join(sysFsBtrfsRoot, filesystem, 'devices');
    if (!existsSync(devicesPath)) continue;
    const members = readdirSync(devicesPath);
    if (members.includes(deviceName)) return members;
  }
  return [deviceName];
}

function leafDevicesUnder(sysBlockRoot: string, deviceName: string): readonly string[] {
  const slavesPath = join(sysBlockRoot, deviceName, 'slaves');
  const slaves = existsSync(slavesPath) ? readdirSync(slavesPath) : [];
  if (slaves.length === 0) return [deviceName];
  return slaves.flatMap((slave) => leafDevicesUnder(sysBlockRoot, slave));
}

function diskHoldingPartition(sysBlockRoot: string, leafName: string): string {
  const disk = readdirSync(sysBlockRoot).find((diskName) => existsSync(join(sysBlockRoot, diskName, leafName)));
  return disk ?? leafName;
}

export function homeDiskNames(sources: DiskBusySources): ReadonlySet<string> {
  try {
    const source = homeMountSource(readFileSync(sources.mountinfoPath, 'utf8'), realpathSync(sources.homePath));
    if (source === undefined) return new Set();
    const homeDevice = blockDeviceNamed(sources.sysBlockRoot, source);
    const disks = btrfsMemberDevices(sources.sysFsBtrfsRoot, homeDevice)
      .flatMap((member) => leafDevicesUnder(sources.sysBlockRoot, member))
      .map((leaf) => diskHoldingPartition(sources.sysBlockRoot, leaf))
      .filter((disk) => isPhysicalDisk(sources.sysBlockRoot, disk));
    return new Set(disks);
  } catch {
    return new Set();
  }
}

function onlyHomeDisks(busyMillisecondsByDisk: BusyMillisecondsByDisk, homeDisks: ReadonlySet<string>): BusyMillisecondsByDisk {
  if (homeDisks.size === 0) return busyMillisecondsByDisk;
  return new Map([...busyMillisecondsByDisk].filter(([deviceName]) => homeDisks.has(deviceName)));
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
  const homeDisks = homeDiskNames(sources);
  const sampleBusyMilliseconds = (): BusyMillisecondsByDisk =>
    onlyHomeDisks(physicalDiskBusyMilliseconds(readFileSync(sources.diskstatsPath, 'utf8'), sources.sysBlockRoot), homeDisks);
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
