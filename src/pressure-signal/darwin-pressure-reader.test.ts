// Requirement: the alpha-autoscale admission gate produces a real verdict on
// macOS. Measured 2026-09-02 in throne-backend.log on the live Mac, every
// tick: `floor breach: live=0 floor=4` then `skip: pressure verdict is
// "unknown"` — the Linux-only `/proc/pressure/*` readers had nothing to read,
// the classifier failed closed as designed, and the throne never spawned an
// Alpha on this host. The Lord: "autoscaler needs to support mac as well."
//
// Every darwin reader is exercised through fixtures here and then fed to the
// REAL classifier, so the thresholds the Lord set (70 merged, 90 io) grade the
// darwin numbers exactly as they grade Linux PSI.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AT_CAPACITY_THRESHOLD,
  classifyPressure,
  type LoadReading,
} from './classify-pressure.ts';
import {
  DARWIN_MEMORY_SYSCTLS,
  memorystatusLevelFloor,
  parseDarwinMemoryKib,
  parseDarwinMemoryPressure,
  readDarwinCpuPressure,
  readDarwinIoPressure,
  readDarwinMemoryPressure,
  utilisationBetween,
  type CpuTimesSample,
} from './darwin-pressure-reader.ts';

const CALM_LOAD: LoadReading = { state: 'ok', load1: 1.2, cpuCount: 12 };

function cores(...perCore: Array<{ busy: number; idle: number }>): CpuTimesSample {
  return perCore.map(({ busy, idle }) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }));
}

test('cpu utilisation is the busy share of the sample window across every core', () => {
  const before = cores({ busy: 100, idle: 100 }, { busy: 100, idle: 100 });
  // Core 0 ran flat out for the window, core 1 sat idle: 50% overall.
  const after = cores({ busy: 200, idle: 100 }, { busy: 100, idle: 200 });
  const reading = utilisationBetween(before, after);
  assert.equal(reading.state, 'ok');
  assert.equal(reading.avg10, 50);
  assert.equal(reading.avg60, 50);
});

test('a zero-length or inconsistent cpu window is unknown, never idle', () => {
  const sample = cores({ busy: 10, idle: 10 });
  assert.equal(utilisationBetween(sample, sample).state, 'unknown');
  assert.equal(utilisationBetween([], []).state, 'unknown');
  assert.equal(utilisationBetween(sample, cores({ busy: 1, idle: 1 }, { busy: 1, idle: 1 })).state, 'unknown');
  // Counters that went backwards (a core hot-unplugged mid-sample) are unknown.
  assert.equal(utilisationBetween(cores({ busy: 50, idle: 50 }), cores({ busy: 40, idle: 60 })).state, 'unknown');
});

test('readDarwinCpuPressure samples twice around the injected sleep', () => {
  const samples = [cores({ busy: 0, idle: 100 }), cores({ busy: 90, idle: 110 })];
  const slept: number[] = [];
  const reading = readDarwinCpuPressure(
    () => samples.shift()!,
    (milliseconds) => slept.push(milliseconds),
    250,
  );
  assert.deepEqual(slept, [250]);
  assert.equal(reading.state, 'ok');
  assert.equal(reading.avg10, 90);
});

test('a throwing cpu sampler reads unknown rather than crashing the tick', () => {
  const reading = readDarwinCpuPressure(
    () => {
      throw new Error('no cpus');
    },
    () => undefined,
  );
  assert.equal(reading.state, 'unknown');
});

test('memory pressure is 100 minus the kernel free percentage when memorystatus is normal', () => {
  // The exact figures measured on the live Mac while writing this:
  // kern.memorystatus_level 85, kern.memorystatus_vm_pressure_level 1.
  const reading = parseDarwinMemoryPressure('85\n1\n');
  assert.equal(reading.state, 'ok');
  assert.equal(reading.avg10, 15);
  assert.equal(reading.avg60, 15);
});

test('the kernel declaring memory WARN pins the reading to the at-capacity threshold', () => {
  // A generous free percentage cannot mask the kernel's own pressure verdict.
  const reading = parseDarwinMemoryPressure('60\n2\n');
  assert.equal(reading.state, 'ok');
  assert.equal(reading.avg10, AT_CAPACITY_THRESHOLD);
  const verdict = classifyPressure(
    { state: 'ok', avg10: 5, avg60: 5 },
    reading,
    CALM_LOAD,
    readDarwinIoPressure(),
  );
  assert.equal(verdict.verdict, 'at-capacity');
});

test('the kernel declaring memory CRITICAL reads as 100', () => {
  const reading = parseDarwinMemoryPressure('30\n4\n');
  assert.equal(reading.state, 'ok');
  assert.equal(reading.avg10, 100);
  assert.equal(memorystatusLevelFloor(4), 100);
});

test('an undocumented memorystatus level or malformed sysctl output is unknown', () => {
  assert.equal(parseDarwinMemoryPressure('85\n3\n').state, 'unknown');
  assert.equal(parseDarwinMemoryPressure('85\n').state, 'unknown');
  assert.equal(parseDarwinMemoryPressure('lots\n1\n').state, 'unknown');
  assert.equal(parseDarwinMemoryPressure('120\n1\n').state, 'unknown');
  assert.equal(parseDarwinMemoryPressure('').state, 'unknown');
  assert.equal(memorystatusLevelFloor(3), null);
});

test('readDarwinMemoryPressure asks sysctl for exactly the two memorystatus keys', () => {
  let asked: readonly string[] | undefined;
  const reading = readDarwinMemoryPressure((names) => {
    asked = names;
    return '40\n1\n';
  });
  assert.deepEqual(asked, [...DARWIN_MEMORY_SYSCTLS]);
  assert.equal(reading.state, 'ok');
  assert.equal(reading.avg10, 60);
  assert.equal(
    readDarwinMemoryPressure(() => {
      throw new Error('sysctl missing');
    }).state,
    'unknown',
  );
});

test('the darwin readers together yield a positive take-more-work verdict on a calm Mac', () => {
  // This is the whole point: the same inputs that were `unknown` forever on
  // this host now reach a real verdict through the unchanged classifier.
  const classification = classifyPressure(
    { state: 'ok', avg10: 20.28, avg60: 20.28 }, // utilisation measured 2026-09-02
    parseDarwinMemoryPressure('85\n1\n'),
    { state: 'ok', load1: 3.49, cpuCount: 16 }, // load measured the same moment
    readDarwinIoPressure(),
  );
  assert.equal(classification.verdict, 'take-more-work');
  assert.ok(classification.pressure !== null);
  assert.ok(classification.pressure < AT_CAPACITY_THRESHOLD);
});

test('a saturated Mac is refused on cpu utilisation alone', () => {
  const classification = classifyPressure(
    { state: 'ok', avg10: 95, avg60: 95 },
    parseDarwinMemoryPressure('85\n1\n'),
    CALM_LOAD,
    readDarwinIoPressure(),
  );
  assert.equal(classification.verdict, 'at-capacity');
});

test('the darwin memory line converts hw.memsize and the free percentage to KiB', () => {
  // 51539607552 bytes = 48 GiB, the live Mac's hw.memsize.
  const kib = parseDarwinMemoryKib('51539607552\n85\n');
  assert.equal(kib.memTotalKib, 50331648);
  assert.equal(kib.memAvailableKib, Math.round(50331648 * 0.85));
  assert.deepEqual(parseDarwinMemoryKib('garbage\n85\n'), { memTotalKib: null, memAvailableKib: null });
  assert.deepEqual(parseDarwinMemoryKib('51539607552\nnope\n'), { memTotalKib: 50331648, memAvailableKib: null });
});
