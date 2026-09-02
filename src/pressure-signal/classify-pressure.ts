import type { PsiReading } from "./psi-pressure-reader.ts";

// The Lord's rulings of 2026-08-17 (relayed via stager-floor): stop admitting
// when ANY of the four windows reaches the threshold. Calibration incidents,
// same day: 09:45 — CPU PSI avg10 83.45 / avg60 83.18, load 48 on 12 cores,
// box subjectively sluggish, yet the original avg60-only/90 classifier said
// take-more-work (fixed to 80 that morning). ~13:00 — at PSI ~82/77 his SSH
// session lagged and KDE died, so 80 dropped to 70 the same afternoon:
// "maybe having the box smooth always is good." 70 is the Lord's standing
// value (commit 6eca72d); pressurescale's e0b6121 restored 80 by accident
// during its merge and the Regent re-restored 70 — do NOT change this
// constant without an explicit Lord ruling.
export const AT_CAPACITY_THRESHOLD = 70;

// THE LORD'S RULING OF 2026-08-27, after the io term produced a FALSE refusal:
// "io has a higher threshold then. try 90".
//
// What was measured to force it, on a box the gate had just declared
// at-capacity at 75.05 on io alone:
//   io full stall  2,911,576 us over 5,053 ms  = 57.6% of wall
//   processes in D state (blocked on io)       = ZERO
//   disk throughput                            = 78 KB/s read, 728 KB/s write
// Under a megabyte per second on an NVMe, nothing blocked, and PSI still
// reporting most tasks stalled. `full` means EVERY non-idle task was stalled,
// and on a near-idle box there is often exactly one non-idle task — so a single
// brief page-in makes that trivially true. `full` is a saturation signal only
// where there is real concurrency to saturate; below that it is an artifact,
// and at 70 the artifact refused every spawn on an idle machine.
//
// 90 is the Lord's value. It keeps io in the admission decision, as he
// originally ordered, while sitting above the artifact band this box floats in
// (io-full measured between 27 and 75 across the session, at rest).
export const IO_AT_CAPACITY_THRESHOLD = 90;

// THE LORD'S RULING OF 2026-08-27: "we also need to take oversubscription into
// account - maintain 0.8x, not 1.8x! fix autoscale". Measured that moment:
// `resource-pressure` returned 43.94 with a `take-more-work` verdict while the
// box ran load 21.77 on 12 cpus — 1.8x per core — because PSI alone never saw
// it. PSI measures STALL (time tasks spent waiting); a run queue can sit at
// nearly twice the core count with cpu-some PSI in the forties, so the gate
// admitted more work into a box that was already oversubscribed.
//
// HIS FOLLOW-UP RULING, same day: "merged pressure figure needs to include load
// btw ... i.e. 0.8x means 80 pressure". Load is therefore a TERM IN THE MERGED
// FIGURE, not a separate limit beside it. An earlier revision of this file
// argued for keeping them separate so the number stayed a pure PSI percentage;
// that argument is overruled and the separate `MAX_LOAD_PER_CORE` constant is
// deleted rather than left dead.
//
// THE CONSEQUENCE, PUT TO HIM AND ACCEPTED: one figure and one threshold means
// the effective load ceiling is 0.70x, not 0.80x, because at-capacity fires at
// 70 and 0.70x scores 70. That is STRICTER than the 0.8x he asked to maintain,
// so "maintain 0.8x" still holds — with margin — and there is no second
// threshold for a reader to remember. A box at 0.75x per core now reports 75
// and is refused.
export const LOAD_PRESSURE_PER_CORE_RATIO = 100;

/** A 1-minute load average against the usable core count, or `unknown` when
 *  either could not be read. `ok`/`unknown` matches `PsiReading`'s own
 *  discriminant rather than introducing a second spelling in one file. */
export type LoadReading =
  | { readonly state: "ok"; readonly load1: number; readonly cpuCount: number }
  | { readonly state: "unknown" };

export type PressureVerdict = "take-more-work" | "at-capacity" | "unknown";

export interface PressureClassification {
  readonly verdict: PressureVerdict;
  readonly pressure: number | null;
  readonly reasons: string[];
}

/**
 * Merges CPU PSI, memory PSI, and run-queue oversubscription into ONE 0–100
 * pressure figure graded against `AT_CAPACITY_THRESHOLD`, and grades IO
 * SEPARATELY against its own, higher `IO_AT_CAPACITY_THRESHOLD`:
 *
 *   pressure = max(cpu.avg10, cpu.avg60, memory.avg10, memory.avg60,
 *                  loadPerCore × 100)          graded at 70
 *   io-full  = max(io.avg10, io.avg60)          graded at 90
 *
 * so 0.8x per core still scores 80 and 1.8x scores 180. Either limit alone is
 * enough to say `at-capacity`.
 *
 * WHY IO IS NOT IN THE FIGURE, having briefly been: a 90-graded term inside a
 * 70-graded number renders as a contradiction — "pressure 75.05 --
 * take-more-work" — and a reader cannot tell whether that is correct or a bug.
 * The figure therefore carries only what 70 governs, and io is reported beside
 * it with its own threshold. This is the one place two thresholds beat one.
 *
 * IO IS THE `full` LINE, NOT `some`, and that choice is load-bearing. Measured
 * 2026-08-27: io `some` was 93.49/95.70 while io `full` was 27.10/49.43. `some`
 * means "at least one task was stalled", the normal condition of any box doing
 * concurrent work; grading it would refuse everything, permanently. The caller
 * passes the `full` reading — see `readPsiFullPressure`.
 *
 * Fails closed on every input: any reading being `unknown` makes the verdict
 * `unknown` rather than falling back to the others. An `unknown` verdict is not
 * an admission — `decideAutoscaleAction` skips on any verdict that is not
 * positively `take-more-work` — so a box whose `/proc` cannot be read stops
 * spawning rather than spawning blind.
 *
 * `load` and `io` are REQUIRED, deliberately. An optional parameter would have
 * left call sites silently on the older, narrower behaviour, and every defect
 * this function has had was a gate admitting work while nobody looked at one
 * of its inputs.
 */
export function classifyPressure(
  cpu: PsiReading,
  memory: PsiReading,
  load: LoadReading,
  io: PsiReading,
): PressureClassification {
  if (
    cpu.state === "unknown" ||
    memory.state === "unknown" ||
    load.state === "unknown" ||
    io.state === "unknown"
  ) {
    return {
      verdict: "unknown",
      pressure: null,
      reasons: [
        ...(cpu.state === "unknown" ? ["cpu pressure reading unknown"] : []),
        ...(memory.state === "unknown"
          ? ["memory pressure reading unknown"]
          : []),
        ...(io.state === "unknown" ? ["io pressure reading unknown"] : []),
        ...(load.state === "unknown" ? ["load reading unknown"] : []),
      ],
    };
  }
  // A zero or negative core count cannot yield a ratio; treat it as unreadable
  // rather than dividing by it. Reported with no pressure figure, because the
  // figure DEPENDS on the load term — publishing a load-free number here would
  // be the silent narrower behaviour this function exists to remove.
  if (load.cpuCount <= 0) {
    return {
      verdict: "unknown",
      pressure: null,
      reasons: ["load reading unknown: cpu count is not positive"],
    };
  }

  const loadPerCore = load.load1 / load.cpuCount;
  const loadPressure = loadPerCore * LOAD_PRESSURE_PER_CORE_RATIO;
  const psiMax = Math.max(cpu.avg10, cpu.avg60, memory.avg10, memory.avg60);
  const pressure = Math.max(psiMax, loadPressure);
  const ioFull = Math.max(io.avg10, io.avg60);

  const pressureAtCapacity = pressure >= AT_CAPACITY_THRESHOLD;
  const ioAtCapacity = ioFull >= IO_AT_CAPACITY_THRESHOLD;
  const verdict: PressureVerdict =
    pressureAtCapacity || ioAtCapacity ? "at-capacity" : "take-more-work";

  return {
    verdict,
    pressure,
    reasons: [
      `pressure ${pressure.toFixed(2)} ${pressureAtCapacity ? ">=" : "<"} ${AT_CAPACITY_THRESHOLD}`,
      `psi max ${psiMax.toFixed(2)} (cpu ${Math.max(cpu.avg10, cpu.avg60).toFixed(2)}, memory ${Math.max(memory.avg10, memory.avg60).toFixed(2)})`,
      `load ${loadPerCore.toFixed(2)}x per core = ${loadPressure.toFixed(2)} pressure`,
      `io-full ${ioFull.toFixed(2)} ${ioAtCapacity ? ">=" : "<"} ${IO_AT_CAPACITY_THRESHOLD}`,
    ],
  };
}
