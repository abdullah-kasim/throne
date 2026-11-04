import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, afterEach, beforeEach, test } from 'node:test';
import {
  FormBaselineExitCode,
  type BaselineFormingContext,
} from '../pressure-baseline/form-baseline.ts';
import {
  baselineFromSamples,
  currentMachine,
  readBaseline,
  writeBaseline,
} from '../pressure-baseline/pressure-baseline-store.ts';
import type { ProbeTimes } from '../pressure-baseline/responsiveness-probes.ts';
import {
  baselineFormingContextFor,
  collectResourcePressureSnapshot,
  formBaselineReportingFailure,
  ResourcePressureCommand,
} from './resource-pressure.command.ts';
import {
  formatResourcePressureReport,
  resourcePressureJson,
} from './resource-pressure-report.ts';

const NOT_QUIET_REASON = 'cpu stall 40% — the machine is not quiet';
const ENOUGH_SAMPLES = 20;
const STORED_GIT_MILLISECONDS = 10;
const STORED_DISK_MILLISECONDS = 2;

const originalHome = process.env.HOME;
const originalDataHome = process.env.THRONE_DATA_HOME;
const scratch: string[] = [];
let userHome: string;
let dataHome: string;

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'resource-pressure-'));
  scratch.push(root);
  userHome = path.join(root, 'home');
  dataHome = path.join(root, 'data');
  await mkdir(userHome);
  process.env.HOME = userHome;
  process.env.THRONE_DATA_HOME = dataHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.THRONE_DATA_HOME = originalDataHome;
  process.exitCode = 0;
});

after(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

async function storeBaselineOf(sampleCount: number): Promise<void> {
  const rounds: ProbeTimes[] = Array.from({ length: sampleCount }, () => ({
    gitMs: STORED_GIT_MILLISECONDS,
    diskMs: STORED_DISK_MILLISECONDS,
  }));
  const now = new Date();
  await writeBaseline(dataHome, baselineFromSamples(await currentMachine(userHome), rounds, now), now);
}

async function reportLines(): Promise<string[]> {
  return formatResourcePressureReport(await collectResourcePressureSnapshot());
}

function lineAfterVerdict(lines: readonly string[]): string {
  const verdictLines = lines.filter(
    (line, index) => index === 0 || line.startsWith('  verdict input:'),
  ).length;
  return lines[verdictLines] ?? '';
}

async function capturingStdout(action: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await action();
  } finally {
    process.stdout.write = originalWrite;
  }
  return captured;
}

test('resource-pressure shows each probe\'s time and its ratio to the baseline beside the verdict', async () => {
  await storeBaselineOf(ENOUGH_SAMPLES);

  const line = lineAfterVerdict(await reportLines());

  assert.match(
    line,
    /^ {2}responsiveness: git \d+(\.\d)?× baseline \(\d+(\.\d)? ms\) · disk \d+(\.\d)?× baseline \(\d+(\.\d)? ms\)$/,
  );
});

test('resource-pressure json carries the probe times and ratios under responsiveness', async () => {
  await storeBaselineOf(ENOUGH_SAMPLES);

  const json = resourcePressureJson(await collectResourcePressureSnapshot()) as {
    responsiveness: {
      state: string;
      baseline: string;
      git: { currentMs: number; ratio: number; sampleCount: number };
      disk: { currentMs: number; ratio: number; sampleCount: number };
    };
  };

  assert.equal(json.responsiveness.state, 'measured');
  assert.equal(json.responsiveness.baseline, 'compared');
  const { git, disk } = json.responsiveness;
  assert.equal(git.ratio, git.currentMs / STORED_GIT_MILLISECONDS);
  assert.equal(disk.ratio, disk.currentMs / STORED_DISK_MILLISECONDS);
  assert.equal(git.sampleCount, ENOUGH_SAMPLES);
  assert.equal(disk.sampleCount, ENOUGH_SAMPLES);
});

test('resource-pressure says no baseline yet until a probe has 20 baseline samples', async () => {
  await storeBaselineOf(ENOUGH_SAMPLES - 1);

  const line = lineAfterVerdict(await reportLines());

  assert.match(line, /git \d+(\.\d)? ms \(no baseline yet, 19 of 20 samples\)/);
  assert.match(line, /disk \d+(\.\d)? ms \(no baseline yet, 19 of 20 samples\)/);
});

test('a probe failure is stated in the resource-pressure report and the command still exits 0', async () => {
  process.env.HOME = path.join(userHome, 'missing');

  const output = await capturingStdout(() => new ResourcePressureCommand().run([]));

  assert.match(output, /\n {2}responsiveness: probe failed — /);
  assert.equal(process.exitCode, 0);
});

test('form-baseline without a terminal exits 1 without reading standard input', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.ReadStream;
  input.write('yes\n');
  const output = new PassThrough();
  let printed = '';
  output.on('data', (chunk) => {
    printed += String(chunk);
  });
  const context: BaselineFormingContext = {
    ...baselineFormingContextFor(input, output as unknown as NodeJS.WriteStream),
    readQuiet: () => ({ quiet: false, reason: NOT_QUIET_REASON }),
  };

  const exitCode = await formBaselineReportingFailure(context);

  assert.equal(exitCode, FormBaselineExitCode.NotFormed);
  assert.equal(printed, `${NOT_QUIET_REASON}\n`);
  assert.equal(input.readableLength, 'yes\n'.length);
  assert.equal(await readBaseline(dataHome), undefined);
});
