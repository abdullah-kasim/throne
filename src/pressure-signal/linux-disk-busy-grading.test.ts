import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCapacityPressure } from '../keep-going/keep-going-pressure-report.ts';
import { readMachineQuiet } from '../pressure-baseline/machine-quiet.ts';
import {
  classifyPressure,
  loadGradedAgainstItsOwnLimit,
  type LoadReading,
} from './classify-pressure.ts';
import {
  parseDarwinMemoryPressure,
  readDarwinIoPressure,
  utilisationBetween,
  type CpuTimesSample,
} from './darwin-pressure-reader.ts';
import { DISK_BUSY_SAMPLE_MS, type DiskBusySources } from './linux-disk-busy-reader.ts';

const CALM_LOAD: LoadReading = { state: 'ok', load1: 1.2, cpuCount: 12 };
const CALM_PSI_FILE = 'some avg10=0.50 avg60=0.50 avg300=0.50 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
const INFLATED_IO_PSI_FILE = 'some avg10=97.00 avg60=96.00 avg300=95.00 total=1\nfull avg10=94.00 avg60=82.00 avg300=80.00 total=1\n';
const fixtureRoots: string[] = [];

after(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

type BusyMillisecondsByDevice = Record<string, number>;

interface Mount {
  readonly at: string;
  readonly fstype: string;
  readonly source: string;
  readonly subvolume?: string;
}

interface HomeLayout {
  readonly mounts: readonly Mount[];
  readonly partitionsByDisk?: Record<string, readonly string[]>;
  readonly slavesByDevice?: Record<string, readonly string[]>;
  readonly deviceMapperNames?: Record<string, string>;
  readonly btrfsDevicesByFilesystem?: Record<string, readonly string[]>;
}

interface LinuxHostFixture {
  readonly cpuPath: string;
  readonly memoryPath: string;
  readonly disk: DiskBusySources;
}

function diskstatsText(busyMillisecondsByDevice: BusyMillisecondsByDevice): string {
  return Object.entries(busyMillisecondsByDevice)
    .map(([deviceName, busyMilliseconds], minor) => `   8 ${minor} ${deviceName} 10 0 80 5 20 0 160 9 0 ${busyMilliseconds} 14 0 0 0 0 0 0`)
    .join('\n');
}

function mountinfoText(realRoot: string, mounts: readonly Mount[]): string {
  return mounts
    .map((mount, index) => {
      const mountPoint = (mount.at === '/' ? realRoot : `${realRoot}${mount.at}`).replaceAll(' ', '\\040');
      return `${index + 30} 1 0:${index + 30} ${mount.subvolume ?? '/'} ${mountPoint} rw,relatime shared:${index + 1} - ${mount.fstype} ${mount.source} rw`;
    })
    .join('\n');
}

function writeHomeLayout(root: string, sysBlockRoot: string, layout: HomeLayout): void {
  const realRoot = realpathSync(root);
  mkdirSync(join(root, 'var', 'home', 'theuser'), { recursive: true });
  mkdirSync(join(root, 'home'));
  symlinkSync(join(root, 'var', 'home', 'theuser'), join(root, 'home', 'theuser'));
  writeFileSync(join(root, 'proc', 'self-mountinfo'), mountinfoText(realRoot, layout.mounts));
  for (const [disk, partitions] of Object.entries(layout.partitionsByDisk ?? {})) {
    for (const partition of partitions) mkdirSync(join(sysBlockRoot, disk, partition), { recursive: true });
  }
  for (const [device, slaves] of Object.entries(layout.slavesByDevice ?? {})) {
    for (const slave of slaves) mkdirSync(join(sysBlockRoot, device, 'slaves', slave), { recursive: true });
  }
  for (const [device, mapperName] of Object.entries(layout.deviceMapperNames ?? {})) {
    mkdirSync(join(sysBlockRoot, device, 'dm'), { recursive: true });
    writeFileSync(join(sysBlockRoot, device, 'dm', 'name'), `${mapperName}\n`);
  }
  for (const [filesystem, devices] of Object.entries(layout.btrfsDevicesByFilesystem ?? {})) {
    for (const device of devices) mkdirSync(join(root, 'sys', 'fs', 'btrfs', filesystem, 'devices', device), { recursive: true });
  }
}

function linuxHostWith(
  physicalDisks: readonly string[],
  before: BusyMillisecondsByDevice,
  afterOneSample: BusyMillisecondsByDevice,
  homeLayout?: HomeLayout,
): LinuxHostFixture {
  const root = mkdtempSync(join(tmpdir(), 'disk busy grading-'));
  fixtureRoots.push(root);
  mkdirSync(join(root, 'proc', 'pressure'), { recursive: true });
  writeFileSync(join(root, 'proc', 'pressure', 'cpu'), CALM_PSI_FILE);
  writeFileSync(join(root, 'proc', 'pressure', 'memory'), CALM_PSI_FILE);
  writeFileSync(join(root, 'proc', 'pressure', 'io'), INFLATED_IO_PSI_FILE);
  const sysBlockRoot = join(root, 'sys', 'block');
  for (const deviceName of Object.keys(before)) mkdirSync(join(sysBlockRoot, deviceName), { recursive: true });
  for (const deviceName of physicalDisks) mkdirSync(join(sysBlockRoot, deviceName, 'device'), { recursive: true });
  if (homeLayout !== undefined) writeHomeLayout(root, sysBlockRoot, homeLayout);
  const diskstatsPath = join(root, 'proc', 'diskstats');
  writeFileSync(diskstatsPath, diskstatsText(before));
  let clockMilliseconds = 0;
  return {
    cpuPath: join(root, 'proc', 'pressure', 'cpu'),
    memoryPath: join(root, 'proc', 'pressure', 'memory'),
    disk: {
      diskstatsPath,
      sysBlockRoot,
      homePath: join(root, 'home', 'theuser'),
      mountinfoPath: join(root, 'proc', 'self-mountinfo'),
      sysFsBtrfsRoot: join(root, 'sys', 'fs', 'btrfs'),
      sleep: (milliseconds) => {
        writeFileSync(diskstatsPath, diskstatsText(afterOneSample));
        clockMilliseconds += milliseconds;
      },
      now: () => clockMilliseconds,
    },
  };
}

function gradeLinuxHost(host: LinuxHostFixture) {
  return readCapacityPressure({ platform: 'linux', load: CALM_LOAD, ...host });
}

function judgeLinuxHostQuiet(host: LinuxHostFixture) {
  return readMachineQuiet({ platform: 'linux', ...host });
}

const HOME_ON_A_NVME_PARTITION: HomeLayout = {
  mounts: [{ at: '/', fstype: 'xfs', source: '/dev/nvme0n1p2' }],
  partitionsByDisk: { nvme0n1: ['nvme0n1p2'], sda: ['sda1'] },
};

function hostWithHomeOnNvmeAndDataOnSda(nvme0n1BusyMilliseconds: number, sdaBusyMilliseconds: number): LinuxHostFixture {
  return linuxHostWith(
    ['nvme0n1', 'sda'],
    { nvme0n1: 500, sda: 7_000 },
    { nvme0n1: 500 + nvme0n1BusyMilliseconds, sda: 7_000 + sdaBusyMilliseconds },
    HOME_ON_A_NVME_PARTITION,
  );
}

function assertAtCapacityWithDiskBusy(host: LinuxHostFixture, expectedReason: string): void {
  const classification = gradeLinuxHost(host);
  assert.equal(classification.verdict, 'at-capacity');
  assert.ok(
    classification.reasons.includes(expectedReason),
    `expected ${expectedReason}, got ${JSON.stringify(classification.reasons)}`,
  );
}

test('an idle Linux disk takes more work even while io pressure reads 94', () => {
  const host = linuxHostWith(['nvme0n1'], { nvme0n1: 2_099_814 }, { nvme0n1: 2_099_814 + 41 });
  const classification = gradeLinuxHost(host);
  assert.equal(DISK_BUSY_SAMPLE_MS, 1000);
  assert.equal(classification.verdict, 'take-more-work');
  assert.ok(
    classification.reasons.includes('disk-busy 4.10% < 90'),
    `expected the disk-busy reason, got ${JSON.stringify(classification.reasons)}`,
  );
});

test('a busy disk that does not hold the home folder beside an idle home disk reads quiet', () => {
  const classification = gradeLinuxHost(hostWithHomeOnNvmeAndDataOnSda(2, 999));
  assert.equal(classification.verdict, 'take-more-work');
  assert.ok(
    classification.reasons.includes('disk-busy 0.20% < 90'),
    `expected only the home disk to be graded, got ${JSON.stringify(classification.reasons)}`,
  );
  assert.deepEqual(judgeLinuxHostQuiet(hostWithHomeOnNvmeAndDataOnSda(2, 999)), { quiet: true });
});

test('a busy home disk reads busy', () => {
  assertAtCapacityWithDiskBusy(hostWithHomeOnNvmeAndDataOnSda(950, 10), 'disk-busy 95.00% >= 90');
  assert.deepEqual(judgeLinuxHostQuiet(hostWithHomeOnNvmeAndDataOnSda(950, 10)), {
    quiet: false,
    reason: 'disk busy 95% — the machine is not quiet',
  });
});

test('a home folder on btrfs over dm-crypt is measured on the disk under the encrypted partition', () => {
  const host = linuxHostWith(
    ['nvme1n1', 'sda', 'sdb'],
    { nvme1n1: 1_000, sda: 1_000, sdb: 1_000, 'dm-0': 1_000 },
    { nvme1n1: 1_000 + 950, sda: 1_000 + 999, sdb: 1_000 + 999, 'dm-0': 1_000 + 999 },
    {
      mounts: [
        { at: '/', fstype: 'xfs', source: '/dev/sda1' },
        { at: '/var', fstype: 'xfs', source: '/dev/sdb1' },
        { at: '/var/home', fstype: 'btrfs', source: '/dev/mapper/luks-home', subvolume: '/home' },
      ],
      partitionsByDisk: { nvme1n1: ['nvme1n1p3'], sda: ['sda1'], sdb: ['sdb1'] },
      slavesByDevice: { 'dm-0': ['nvme1n1p3'] },
      deviceMapperNames: { 'dm-0': 'luks-home' },
      btrfsDevicesByFilesystem: { 'aaaa1111': ['dm-0'] },
    },
  );
  assertAtCapacityWithDiskBusy(host, 'disk-busy 95.00% >= 90');
});

test('a btrfs home spanning several devices is measured on every disk the filesystem lists', () => {
  const host = linuxHostWith(
    ['sda', 'sdb', 'sdc'],
    { sda: 1_000, sdb: 1_000, sdc: 1_000 },
    { sda: 1_000 + 999, sdb: 1_000 + 10, sdc: 1_000 + 950 },
    {
      mounts: [{ at: '/', fstype: 'btrfs', source: '/dev/sdb1' }],
      partitionsByDisk: { sda: ['sda1'], sdb: ['sdb1'], sdc: ['sdc1'] },
      btrfsDevicesByFilesystem: { 'bbbb2222': ['sdb1', 'sdc1'], 'cccc3333': ['sda1'] },
    },
  );
  assertAtCapacityWithDiskBusy(host, 'disk-busy 95.00% >= 90');
});

test('when the home disk cannot be worked out every physical disk is measured as before', () => {
  const unresolvableLayouts: Record<string, HomeLayout | undefined> = {
    'unreadable mountinfo': undefined,
    'no matching mount': { mounts: [{ at: '/srv/data', fstype: 'xfs', source: '/dev/nvme0n1p2' }], partitionsByDisk: { nvme0n1: ['nvme0n1p2'] } },
    'nothing physical underneath': { mounts: [{ at: '/', fstype: 'tmpfs', source: 'tmpfs' }] },
  };
  for (const [failure, layout] of Object.entries(unresolvableLayouts)) {
    const host = linuxHostWith(['nvme0n1', 'sda'], { nvme0n1: 500, sda: 7_000 }, { nvme0n1: 500 + 10, sda: 7_000 + 950 }, layout);
    const classification = gradeLinuxHost(host);
    assert.equal(classification.verdict, 'at-capacity', failure);
    assert.ok(classification.reasons.includes('disk-busy 95.00% >= 90'), `${failure}: ${JSON.stringify(classification.reasons)}`);
  }
});

test('loop, zram, device-mapper and partition rows never count as disk busy', () => {
  const before = { nvme0n1: 100, nvme0n1p1: 100, sda: 100, sda1: 100, loop0: 100, zram0: 100, 'dm-0': 100 };
  const host = linuxHostWith(['nvme0n1', 'sda'], before, {
    nvme0n1: 110,
    nvme0n1p1: 1_100,
    sda: 110,
    sda1: 1_100,
    loop0: 1_100,
    zram0: 1_100,
    'dm-0': 1_100,
  });
  const classification = gradeLinuxHost(host);
  assert.equal(classification.verdict, 'take-more-work');
  assert.ok(
    classification.reasons.includes('disk-busy 1.00% < 90'),
    `expected only the physical disks to be graded, got ${JSON.stringify(classification.reasons)}`,
  );
});

test('an unreadable diskstats file gives no verdict', () => {
  const host = linuxHostWith(['nvme0n1'], { nvme0n1: 100 }, { nvme0n1: 110 });
  const classification = gradeLinuxHost({
    ...host,
    disk: { ...host.disk, diskstatsPath: join(host.disk.sysBlockRoot, 'no-such-diskstats') },
  });
  assert.equal(classification.verdict, 'unknown');
  assert.deepEqual(classification.reasons, ['disk-busy reading unknown']);
});

test('a box with no physical disks gives no verdict', () => {
  const host = linuxHostWith([], { loop0: 100, zram0: 100, 'dm-0': 100 }, { loop0: 110, zram0: 110, 'dm-0': 110 });
  const classification = gradeLinuxHost(host);
  assert.equal(classification.verdict, 'unknown');
  assert.deepEqual(classification.reasons, ['disk-busy reading unknown']);
});

test('the Mac verdict is unchanged and never reads diskstats', () => {
  const cpuBefore: CpuTimesSample = [{ times: { user: 100, nice: 0, sys: 20, idle: 880, irq: 0 } }];
  const cpuAfter: CpuTimesSample = [{ times: { user: 400, nice: 0, sys: 50, idle: 1_550, irq: 0 } }];
  const memorystatusOutput = '62\n1\n';
  const macLoadLimitPerCore = 5;
  const saturatedHost = linuxHostWith(['nvme0n1'], { nvme0n1: 0 }, { nvme0n1: 1_000 });
  const diskSourceCalls: string[] = [];
  const cpuSamples = [cpuBefore, cpuAfter];

  const classification = readCapacityPressure({
    platform: 'darwin',
    load: CALM_LOAD,
    macLoadLimitPerCore,
    sampleDarwinCpus: () => cpuSamples.shift()!,
    sleepDuringDarwinCpuSample: () => undefined,
    readDarwinSysctl: () => memorystatusOutput,
    disk: {
      ...saturatedHost.disk,
      sleep: () => diskSourceCalls.push('sleep'),
      now: () => {
        diskSourceCalls.push('now');
        return 0;
      },
    },
  });

  assert.deepEqual(diskSourceCalls, []);
  assert.deepEqual(
    classification,
    classifyPressure(
      utilisationBetween(cpuBefore, cpuAfter),
      parseDarwinMemoryPressure(memorystatusOutput),
      CALM_LOAD,
      readDarwinIoPressure(),
      loadGradedAgainstItsOwnLimit(macLoadLimitPerCore),
    ),
  );
  assert.equal(classification.verdict, 'take-more-work');
});
