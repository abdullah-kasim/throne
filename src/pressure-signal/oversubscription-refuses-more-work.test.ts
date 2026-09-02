// Requirement: run-queue oversubscription is part of the merged pressure
// figure, so 0.8x per core reads as 80 pressure and a loaded box is refused.
//
// The Lord, 2026-08-27: "we also need to take oversubscription into account -
// maintain 0.8x, not 1.8x! fix autoscale", then: "merged pressure figure needs
// to include load btw ... i.e. 0.8x means 80 pressure".
//
// Measured when he complained: `resource-pressure` reported 43.94 and a
// take-more-work verdict while the box ran load 21.77 on 12 cpus — 1.8x per
// core. PSI measures STALL, so a run queue at nearly twice the core count is
// invisible to it and the gate kept admitting.
//
// THE ACCEPTED CONSEQUENCE, put to him and chosen deliberately: one figure and
// one threshold means the effective load ceiling is 0.70x, not 0.80x, because
// at-capacity fires at 70 and 0.70x scores 70. That is stricter than the 0.8x
// he asked to maintain, so the instruction still holds, with margin.
//
// Exercised through the real classifier the admission gate calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AT_CAPACITY_THRESHOLD,
  IO_AT_CAPACITY_THRESHOLD,
  classifyPressure,
  type LoadReading,
} from "./classify-pressure.ts";
import { readPsiFullPressure, type PsiReading } from "./psi-pressure-reader.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** PSI well under the threshold, so only the load term can move the figure. */
const CALM_PSI: PsiReading = { state: "ok", avg10: 10, avg60: 10 };
const CALM_LOAD: LoadReading = { state: "ok", load1: 1.2, cpuCount: 12 };
/** io `full` well under the threshold, so it never drives the figure here. */
const CALM_IO: PsiReading = { state: "ok", avg10: 5, avg60: 5 };

test("0.8x per core reads as 80 pressure", () => {
  const at08 = classifyPressure(CALM_PSI, CALM_PSI, {
    state: "ok",
    load1: 9.6,
    cpuCount: 12,
  },
    CALM_IO,
  );
  assert.ok(at08.pressure !== null);
  assert.equal(Math.round(at08.pressure), 80);
  assert.equal(at08.verdict, "at-capacity");
});

test("the box refuses more work when the run queue is oversubscribed", () => {
  // The exact reading measured when the Lord complained: 1.8x scores 180.
  const measured = classifyPressure(CALM_PSI, CALM_PSI, {
    state: "ok",
    load1: 21.77,
    cpuCount: 12,
  },
    CALM_IO,
  );
  assert.ok(measured.pressure !== null);
  assert.equal(Math.round(measured.pressure), 181);
  assert.equal(measured.verdict, "at-capacity");
  assert.ok(
    measured.reasons.some((reason) => reason.includes("1.81x per core")),
    `expected a reason naming the ratio, got ${JSON.stringify(measured.reasons)}`,
  );
});

test("the effective load ceiling is the threshold, at 0.70x per core", () => {
  // 0.69x scores 69 and is admitted; 0.70x scores 70 and is refused. This is
  // the accepted cost of one figure and one threshold.
  assert.equal(
    classifyPressure(CALM_PSI, CALM_PSI, {
      state: "ok",
      load1: 8.28,
      cpuCount: 12,
    },
    CALM_IO,
  ).verdict,
    "take-more-work",
    "0.69x per core must still admit work",
  );
  assert.equal(
    classifyPressure(CALM_PSI, CALM_PSI, {
      state: "ok",
      load1: 8.4,
      cpuCount: 12,
    },
    CALM_IO,
  ).verdict,
    "at-capacity",
    "0.70x per core scores 70 and must be refused",
  );
});

test("low stall does not admit work while the box is oversubscribed", () => {
  // The defect in one assertion: calm PSI must not rescue a loaded box.
  const calmButLoaded = classifyPressure(
    { state: "ok", avg10: 43.9, avg60: 30.9 },
    { state: "ok", avg10: 1.1, avg60: 2.0 },
    { state: "ok", load1: 21.77, cpuCount: 12 },
    CALM_IO,
  );
  assert.equal(calmButLoaded.verdict, "at-capacity");
  assert.ok(calmButLoaded.pressure !== null);
  assert.ok(
    calmButLoaded.pressure > 43.9,
    "the merged figure must be driven by the load term, not the PSI max",
  );
});

test("an idle box with high stall still refuses on stall alone", () => {
  const stalling = classifyPressure(
    { state: "ok", avg10: 85, avg60: 80 },
    CALM_PSI,
    { state: "ok", load1: 0.1, cpuCount: 12 },
    CALM_IO,
  );
  assert.equal(stalling.verdict, "at-capacity");
  assert.equal(stalling.pressure, 85);
});

test("a calm, unloaded box takes more work", () => {
  const calm = classifyPressure(CALM_PSI, CALM_PSI, CALM_LOAD, CALM_IO);
  assert.equal(calm.verdict, "take-more-work");
  assert.equal(calm.pressure, 10);
  assert.ok(
    calm.pressure < AT_CAPACITY_THRESHOLD,
    "a calm box must sit under the threshold",
  );
  assert.ok(
    calm.reasons.some((reason) => reason.includes("0.10x per core")),
    "the load ratio is reported even when it admits",
  );
});

test("an unreadable load reading is never treated as an idle box", () => {
  // Fails closed: `unknown` is not an admission, because decideAutoscaleAction
  // skips on any verdict that is not positively take-more-work.
  const unreadable = classifyPressure(CALM_PSI, CALM_PSI, { state: "unknown" }, CALM_IO);
  assert.equal(unreadable.verdict, "unknown");
  assert.equal(unreadable.pressure, null);

  const noCores = classifyPressure(CALM_PSI, CALM_PSI, {
    state: "ok",
    load1: 1,
    cpuCount: 0,
  },
    CALM_IO,
  );
  assert.equal(noCores.verdict, "unknown");
  assert.equal(
    noCores.pressure,
    null,
    "the figure depends on the load term, so it must not publish a PSI-only number",
  );
});

// ---------------------------------------------------------------------------
// IO. The Lord, 2026-08-27: "give io the same treatment - it should be included
// in the autoscaler's threshold". Which LINE is read decides whether the gate
// works at all: measured that moment, io `some` was 93.49/95.70 while io `full`
// was 27.10/49.43. Merging `some` would have held the figure above every
// threshold permanently.
// ---------------------------------------------------------------------------

test("a box that cannot make progress on disk refuses more work", () => {
  const ioStalled = classifyPressure(CALM_PSI, CALM_PSI, CALM_LOAD, {
    state: "ok",
    avg10: 91,
    avg60: 40,
  });
  assert.equal(ioStalled.verdict, "at-capacity");
  assert.ok(
    ioStalled.reasons.some((reason) => reason.includes("io-full 91.00 >= 90")),
    `expected a reason naming the io term and its own threshold, got ${JSON.stringify(ioStalled.reasons)}`,
  );
});

test("io is graded at 90, not at the 70 the other signals share", () => {
  assert.equal(IO_AT_CAPACITY_THRESHOLD, 90);
  // THE FALSE REFUSAL THIS EXISTS TO PREVENT, measured 2026-08-27: io-full
  // 75.05 while the disk moved 0.8 MB/s with ZERO processes blocked on it. At
  // the shared 70 that refused every spawn on an idle box.
  const artifact = classifyPressure(CALM_PSI, CALM_PSI, CALM_LOAD, {
    state: "ok",
    avg10: 75.05,
    avg60: 60,
  });
  assert.equal(artifact.verdict, "take-more-work");
  // And the figure must NOT carry io, or it would read "75.05 -- take-more-work".
  assert.equal(artifact.pressure, 10);
});

test("ordinary disk contention does not refuse work", () => {
  // The measured io `full` reading from the live box: high, but not stalling.
  // If this ever starts returning at-capacity, someone has switched the gate
  // to the `some` line and the court will stop spawning entirely.
  const busyDisk = classifyPressure(CALM_PSI, CALM_PSI, CALM_LOAD, {
    state: "ok",
    avg10: 27.1,
    avg60: 49.43,
  });
  assert.equal(busyDisk.verdict, "take-more-work");
  assert.equal(busyDisk.pressure, 10, "io must not appear in the 70-graded figure");
});

test("an unreadable io reading is never treated as an idle disk", () => {
  const unreadable = classifyPressure(CALM_PSI, CALM_PSI, CALM_LOAD, {
    state: "unknown",
    avg10: null,
    avg60: null,
  });
  assert.equal(unreadable.verdict, "unknown");
  assert.equal(unreadable.pressure, null);
  assert.ok(unreadable.reasons.some((reason) => reason.includes("io")));
});

test("the io term is read from the full line, not some", () => {
  // Guards the decision itself against a well-meaning future edit: a real PSI
  // file body where the two lines differ sharply, parsed through the reader the
  // gate actually calls.
  const body =
    "some avg10=93.49 avg60=95.70 avg300=95.44 total=845084869688\n" +
    "full avg10=27.10 avg60=49.43 avg300=44.26 total=685083727311\n";
  const path = join(mkdtempSync(join(tmpdir(), "throne-psi-")), "io");
  writeFileSync(path, body);
  const full = readPsiFullPressure(path);
  assert.equal(full.state, "ok");
  assert.equal(full.avg10, 27.1);
  assert.equal(full.avg60, 49.43);
});
