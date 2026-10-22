import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCapacityPressure } from '../keep-going/keep-going-pressure-report.ts';
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
const CALM_PSI_FILE = 'some avg10=5.00 avg60=5.00 avg300=5.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
const INFLATED_IO_PSI_FILE = 'some avg10=97.00 avg60=96.00 avg300=95.00 total=1\nfull avg10=94.00 avg60=82.00 avg300=80.00 total=1\n';
const fixtureRoots: string[] = [];

after(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

type BusyMillisecondsByDevice = Record<string, number>;

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

function linuxHostWith(
  physicalDisks: readonly string[],
  before: BusyMillisecondsByDevice,
  afterOneSample: BusyMillisecondsByDevice,
): LinuxHostFixture {
  const root = mkdtempSync(join(tmpdir(), 'disk-busy-grading-'));
  fixtureRoots.push(root);
  mkdirSync(join(root, 'proc', 'pressure'), { recursive: true });
  writeFileSync(join(root, 'proc', 'pressure', 'cpu'), CALM_PSI_FILE);
  writeFileSync(join(root, 'proc', 'pressure', 'memory'), CALM_PSI_FILE);
  writeFileSync(join(root, 'proc', 'pressure', 'io'), INFLATED_IO_PSI_FILE);
  const sysBlockRoot = join(root, 'sys', 'block');
  for (const deviceName of Object.keys(before)) mkdirSync(join(sysBlockRoot, deviceName), { recursive: true });
  for (const deviceName of physicalDisks) mkdirSync(join(sysBlockRoot, deviceName, 'device'), { recursive: true });
  const diskstatsPath = join(root, 'proc', 'diskstats');
  writeFileSync(diskstatsPath, diskstatsText(before));
  let clockMilliseconds = 0;
  return {
    cpuPath: join(root, 'proc', 'pressure', 'cpu'),
    memoryPath: join(root, 'proc', 'pressure', 'memory'),
    disk: {
      diskstatsPath,
      sysBlockRoot,
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

test('one saturated disk refuses more work even beside an idle one', () => {
  const host = linuxHostWith(
    ['nvme0n1', 'sda'],
    { nvme0n1: 500, sda: 7_000 },
    { nvme0n1: 500 + 950, sda: 7_000 + 10 },
  );
  const classification = gradeLinuxHost(host);
  assert.equal(classification.verdict, 'at-capacity');
  assert.ok(
    classification.reasons.includes('disk-busy 95.00% >= 90'),
    `expected the saturated disk to be named, got ${JSON.stringify(classification.reasons)}`,
  );
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
