import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  BASELINE_ROUND_SPACING_MILLISECONDS,
  BASELINE_ROUNDS,
  formBaseline,
  FORM_UNDER_LOAD_PROMPT,
  FormBaselineExitCode,
  type BaselineFormingContext,
} from "./form-baseline.ts";
import type { QuietReading } from "./machine-quiet.ts";
import {
  baselineFileIn,
  baselineFromSamples,
  currentMachine,
  readBaseline,
  writeBaseline,
  type MachineIdentity,
  type PressureBaseline,
} from "./pressure-baseline-store.ts";
import { probeResponsiveness, type ProbeTimes } from "./responsiveness-probes.ts";
import { BaselineState, compareToBaseline, formatResponsivenessLine } from "./responsiveness-report.ts";
import { sweepResponsiveness } from "./sweep-responsiveness.ts";

const BUSY_REASON = "disk busy 60% — the machine is not quiet";
const QUIET: QuietReading = { quiet: true };
const BUSY: QuietReading = { quiet: false, reason: BUSY_REASON };
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-28T12:00:00.000Z");
const CURRENT_TIMES: ProbeTimes = { gitMs: 42, diskMs: 9 };

let scratchRoot: string;
let dataHome: string;
let userHome: string;
let machine: MachineIdentity;

interface FormingRoom {
  readonly context: BaselineFormingContext;
  readonly printed: string[];
  readonly questions: string[];
  readonly sleeps: number[];
}

function formingRoom(quiet: QuietReading, inputIsTerminal: boolean, answer?: string): FormingRoom {
  const printed: string[] = [];
  const questions: string[] = [];
  const sleeps: number[] = [];
  const context: BaselineFormingContext = {
    dataHome,
    userHome,
    inputIsTerminal,
    ask: async (question) => {
      questions.push(question);
      return answer;
    },
    print: (line) => printed.push(line),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    readQuiet: () => quiet,
  };
  return { context, printed, questions, sleeps };
}

function repeatedTimes(count: number, gitMs: number, diskMs: number): ProbeTimes[] {
  return Array.from({ length: count }, () => ({ gitMs, diskMs }));
}

async function storedBaseline(): Promise<PressureBaseline> {
  const baseline = await readBaseline(dataHome);
  assert.ok(baseline, "the baseline file should exist");
  return baseline;
}

async function assertNothingFormed(room: FormingRoom, expectedQuestions: readonly string[]): Promise<void> {
  assert.equal(await formBaseline(room.context), FormBaselineExitCode.NotFormed);
  assert.equal(await readBaseline(dataHome), undefined);
  assert.deepEqual(room.printed, [BUSY_REASON]);
  assert.deepEqual(room.questions, expectedQuestions);
}

async function writeOldBaseline(): Promise<void> {
  await writeBaseline(dataHome, baselineFromSamples(machine, repeatedTimes(3, 999, 999), new Date()), new Date());
}

before(async () => {
  scratchRoot = await mkdtemp(path.join(os.tmpdir(), "pressure-baseline-"));
  userHome = path.join(scratchRoot, "home");
  dataHome = path.join(userHome, ".throne");
  await probeResponsiveness(dataHome, userHome);
  machine = await currentMachine(userHome);
});

beforeEach(async () => {
  await rm(baselineFileIn(dataHome), { force: true });
});

after(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

test("forming the baseline on a quiet machine takes 20 rounds of both probes and replaces the file", async () => {
  await writeOldBaseline();
  const room = formingRoom(QUIET, false);

  assert.equal(await formBaseline(room.context), FormBaselineExitCode.Formed);

  const baseline = await storedBaseline();
  assert.equal(baseline.probes.git.samples.length, BASELINE_ROUNDS);
  assert.equal(baseline.probes.disk.samples.length, BASELINE_ROUNDS);
  assert.ok(baseline.probes.git.samples.every((sample) => sample.ms < 999));
  assert.equal(baseline.formedUnderLoad, false);
  assert.deepEqual(baseline.machine, machine);
  assert.deepEqual(room.sleeps, Array(BASELINE_ROUNDS - 1).fill(BASELINE_ROUND_SPACING_MILLISECONDS));
  assert.deepEqual(room.questions, []);
  assert.match(room.printed[0] ?? "", /^baseline formed: git median [0-9.]+ ms · disk median [0-9.]+ ms$/);
  assert.equal(room.printed[1], `baseline file: ${baselineFileIn(dataHome)}`);
});

test("forming the baseline records each sample at the moment its round was taken", async () => {
  let clock = NOW.getTime();
  const room = formingRoom(QUIET, false);
  const context: BaselineFormingContext = {
    ...room.context,
    now: () => new Date(clock),
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  };

  assert.equal(await formBaseline(context), FormBaselineExitCode.Formed);

  const roundTimes = Array.from({ length: BASELINE_ROUNDS }, (_, round) =>
    new Date(NOW.getTime() + round * BASELINE_ROUND_SPACING_MILLISECONDS).toISOString(),
  );
  const baseline = await storedBaseline();
  assert.deepEqual(baseline.probes.git.samples.map((sample) => sample.at), roundTimes);
  assert.deepEqual(baseline.probes.disk.samples.map((sample) => sample.at), roundTimes);
});

test("forming the baseline under load with a terminal answered y forms it and marks it formed under load", async () => {
  for (const answer of ["y", " YES\n"]) {
    const room = formingRoom(BUSY, true, answer);

    assert.equal(await formBaseline(room.context), FormBaselineExitCode.Formed);

    const baseline = await storedBaseline();
    assert.equal(baseline.formedUnderLoad, true);
    assert.equal(baseline.formedUnderLoadReason, BUSY_REASON);
    assert.equal(baseline.probes.git.samples.length, BASELINE_ROUNDS);
    assert.deepEqual(room.questions, [FORM_UNDER_LOAD_PROMPT]);
    assert.equal(room.printed[0], BUSY_REASON);
  }
});

test("forming the baseline under load with a terminal answered n or nothing forms nothing and exits 1", async () => {
  for (const answer of ["n", "", undefined]) {
    const room = formingRoom(BUSY, true, answer);

    await assertNothingFormed(room, [FORM_UNDER_LOAD_PROMPT]);
  }
});

test("forming the baseline under load without a terminal forms nothing, exits 1 and never reads input", async () => {
  const room = formingRoom(BUSY, false, "y");

  await assertNothingFormed(room, []);
});

test("samples older than 7 days drop out of the baseline and the median is taken over the rest", async () => {
  const eightDaysAgo = new Date(NOW.getTime() - 8 * DAY_MILLISECONDS);
  const sixDaysAgo = new Date(NOW.getTime() - 6 * DAY_MILLISECONDS);
  const old = baselineFromSamples(machine, repeatedTimes(5, 500, 500), eightDaysAgo);
  const recent = baselineFromSamples(machine, [...repeatedTimes(2, 10, 1), ...repeatedTimes(1, 40, 7)], sixDaysAgo);
  const mixed: PressureBaseline = {
    ...old,
    probes: {
      git: { medianMs: null, samples: [...old.probes.git.samples, ...recent.probes.git.samples] },
      disk: { medianMs: null, samples: [...old.probes.disk.samples, ...recent.probes.disk.samples] },
    },
  };

  await writeBaseline(dataHome, mixed, NOW);

  const baseline = await storedBaseline();
  assert.equal(baseline.probes.git.samples.length, 3);
  assert.equal(baseline.probes.git.medianMs, 10);
  assert.equal(baseline.probes.disk.medianMs, 1);
});

test("a probe with fewer than 20 baseline samples reads no baseline yet", () => {
  const sevenSamples = baselineFromSamples(machine, repeatedTimes(7, 10, 1), NOW);
  const twentySamples = baselineFromSamples(machine, repeatedTimes(20, 10, 1), NOW);

  assert.equal(
    formatResponsivenessLine(compareToBaseline(CURRENT_TIMES, sevenSamples, machine, NOW)),
    "responsiveness: git 42 ms (no baseline yet, 7 of 20 samples) · disk 9 ms (no baseline yet, 7 of 20 samples)",
  );
  assert.equal(
    formatResponsivenessLine(compareToBaseline(CURRENT_TIMES, undefined, machine, NOW)),
    "responsiveness: git 42 ms (no baseline yet, 0 of 20 samples) · disk 9 ms (no baseline yet, 0 of 20 samples)",
  );
  assert.equal(
    formatResponsivenessLine(compareToBaseline(CURRENT_TIMES, twentySamples, machine, NOW)),
    "responsiveness: git 4.2× baseline (42 ms) · disk 9.0× baseline (9 ms)",
  );
  assert.equal(
    formatResponsivenessLine(
      compareToBaseline(CURRENT_TIMES, { ...twentySamples, formedUnderLoad: true }, machine, NOW),
    ),
    "responsiveness: git 4.2× baseline (42 ms) · disk 9.0× baseline (9 ms) (baseline formed under load)",
  );
});

test("a baseline whose machine differs reads as baseline from another machine and is never compared", () => {
  const otherMachine = baselineFromSamples({ ...machine, kernelRelease: "another kernel" }, repeatedTimes(20, 10, 1), NOW);

  const report = compareToBaseline(CURRENT_TIMES, otherMachine, machine, NOW);

  assert.equal(formatResponsivenessLine(report), "responsiveness: git 42 ms · disk 9 ms (baseline from another machine)");
  assert.ok(report.state === "measured");
  assert.equal(report.baseline, BaselineState.AnotherMachine);
  assert.equal(report.git.ratio, null);
  assert.equal(report.disk.ratio, null);
});

test("a quiet sweep adds both samples to the baseline and a busy sweep adds none", async () => {
  const busyLine = await sweepResponsiveness({ dataHome, userHome, readQuiet: () => BUSY });
  assert.match(busyLine, /^responsiveness: git .* \(no baseline yet, 0 of 20 samples\); samples not added: disk busy 60% — the machine is not quiet$/);
  assert.equal(await readBaseline(dataHome), undefined);

  const quietLine = await sweepResponsiveness({ dataHome, userHome, readQuiet: () => QUIET });
  assert.match(quietLine, /; samples added to the baseline$/);
  const baseline = await storedBaseline();
  assert.equal(baseline.probes.git.samples.length, 1);
  assert.equal(baseline.probes.disk.samples.length, 1);
  assert.equal(baseline.formedUnderLoad, false);

  await sweepResponsiveness({ dataHome, userHome, readQuiet: () => BUSY });
  assert.equal((await storedBaseline()).probes.git.samples.length, 1);
});

test("a quiet sweep replaces a baseline from another machine with one for this machine", async () => {
  const otherMachine = baselineFromSamples({ ...machine, cpuModel: "another cpu" }, repeatedTimes(20, 10, 1), new Date());
  await writeBaseline(dataHome, otherMachine, new Date());

  const line = await sweepResponsiveness({ dataHome, userHome, readQuiet: () => QUIET });

  assert.match(line, /\(baseline from another machine\); samples added to the baseline$/);
  const baseline = await storedBaseline();
  assert.deepEqual(baseline.machine, machine);
  assert.equal(baseline.probes.git.samples.length, 1);
});

test("a probe failure during a sweep is one log line and does not throw", async () => {
  const fileInTheWay = path.join(scratchRoot, "not-a-folder");
  await writeFile(fileInTheWay, "");

  const line = await sweepResponsiveness({ dataHome: path.join(fileInTheWay, ".throne"), userHome, readQuiet: () => QUIET });

  assert.match(line, /^responsiveness: probe failed — \S.*$/);
  assert.equal(line.includes("\n"), false);
});
