import {
  currentMachine,
  keepRecentSamples,
  readBaseline,
  sameMachine,
  type MachineIdentity,
  type PressureBaseline,
  type ProbeBaseline,
} from "./pressure-baseline-store.ts";
import { probeResponsiveness, type ProbeTimes } from "./responsiveness-probes.ts";

export const ENOUGH_BASELINE_SAMPLES = 20;

const LINE_LABEL = "responsiveness:";
const PROBE_SEPARATOR = " · ";

export enum BaselineState {
  Compared = "compared",
  Missing = "missing",
  AnotherMachine = "another-machine",
}

export interface ProbeComparison {
  readonly currentMs: number;
  readonly medianMs: number | null;
  readonly ratio: number | null;
  readonly sampleCount: number;
}

export type ResponsivenessReport =
  | {
      readonly state: "measured";
      readonly baseline: BaselineState;
      readonly formedUnderLoad: boolean;
      readonly git: ProbeComparison;
      readonly disk: ProbeComparison;
      readonly error: null;
    }
  | { readonly state: "failed"; readonly error: string };

function baselineStateOf(baseline: PressureBaseline | undefined, machine: MachineIdentity): BaselineState {
  if (baseline === undefined) return BaselineState.Missing;
  return sameMachine(baseline.machine, machine) ? BaselineState.Compared : BaselineState.AnotherMachine;
}

function compareProbe(currentMs: number, probe: ProbeBaseline | undefined, state: BaselineState): ProbeComparison {
  const sampleCount = state === BaselineState.Compared ? (probe?.samples.length ?? 0) : 0;
  const medianMs = state === BaselineState.Compared ? (probe?.medianMs ?? null) : null;
  const ratio = sampleCount >= ENOUGH_BASELINE_SAMPLES && medianMs !== null ? currentMs / medianMs : null;
  return { currentMs, medianMs, ratio, sampleCount };
}

export function compareToBaseline(
  times: ProbeTimes,
  baseline: PressureBaseline | undefined,
  machine: MachineIdentity,
  now: Date,
): ResponsivenessReport {
  const state = baselineStateOf(baseline, machine);
  const recent = baseline === undefined ? undefined : keepRecentSamples(baseline, now);
  return {
    state: "measured",
    baseline: state,
    formedUnderLoad: state === BaselineState.Compared && recent?.formedUnderLoad === true,
    git: compareProbe(times.gitMs, recent?.probes.git, state),
    disk: compareProbe(times.diskMs, recent?.probes.disk, state),
    error: null,
  };
}

export function probeFailureReport(error: unknown): ResponsivenessReport {
  const message = error instanceof Error ? error.message : String(error);
  return { state: "failed", error: message.replace(/\s+/g, " ").trim() };
}

export async function measureResponsiveness(
  dataHome: string,
  userHome: string,
  now: Date = new Date(),
): Promise<ResponsivenessReport> {
  try {
    const times = await probeResponsiveness(dataHome, userHome);
    return compareToBaseline(times, await readBaseline(dataHome), await currentMachine(userHome), now);
  } catch (error) {
    return probeFailureReport(error);
  }
}

export function formatMilliseconds(milliseconds: number): string {
  return `${Number(milliseconds.toFixed(1))} ms`;
}

function formatProbe(name: string, comparison: ProbeComparison): string {
  if (comparison.ratio !== null) {
    return `${name} ${comparison.ratio.toFixed(1)}× baseline (${formatMilliseconds(comparison.currentMs)})`;
  }
  return `${name} ${formatMilliseconds(comparison.currentMs)} (no baseline yet, ${comparison.sampleCount} of ${ENOUGH_BASELINE_SAMPLES} samples)`;
}

export function formatResponsivenessLine(report: ResponsivenessReport): string {
  if (report.state === "failed") return `${LINE_LABEL} probe failed — ${report.error}`;
  if (report.baseline === BaselineState.AnotherMachine) {
    const times = [`git ${formatMilliseconds(report.git.currentMs)}`, `disk ${formatMilliseconds(report.disk.currentMs)}`];
    return `${LINE_LABEL} ${times.join(PROBE_SEPARATOR)} (baseline from another machine)`;
  }
  const probes = [formatProbe("git", report.git), formatProbe("disk", report.disk)].join(PROBE_SEPARATOR);
  return `${LINE_LABEL} ${probes}${report.formedUnderLoad ? " (baseline formed under load)" : ""}`;
}
