import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readTextFileIfPresent } from "../where-i-stand/file-presence.ts";
import { deviceOf, type DeviceOf, type ProbeTimes } from "./responsiveness-probes.ts";

export const BASELINE_FILE_NAME = "pressure-baseline.json";
export const BASELINE_FILE_VERSION = 1;
export const SAMPLE_WINDOW_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

const UNKNOWN_CPU_MODEL = "unknown";

export interface MachineIdentity {
  readonly cpuModel: string;
  readonly kernelRelease: string;
  readonly homeDevice: number;
}

export interface ProbeSample {
  readonly ms: number;
  readonly at: string;
}

export interface ProbeBaseline {
  readonly medianMs: number | null;
  readonly samples: readonly ProbeSample[];
}

export interface ProbeBaselines {
  readonly git: ProbeBaseline;
  readonly disk: ProbeBaseline;
}

export interface PressureBaseline {
  readonly version: typeof BASELINE_FILE_VERSION;
  readonly machine: MachineIdentity;
  readonly formedUnderLoad: boolean;
  readonly formedUnderLoadReason?: string;
  readonly probes: ProbeBaselines;
}

export async function currentMachine(userHome: string, deviceOfLocation: DeviceOf = deviceOf): Promise<MachineIdentity> {
  return {
    cpuModel: os.cpus()[0]?.model ?? UNKNOWN_CPU_MODEL,
    kernelRelease: os.release(),
    homeDevice: await deviceOfLocation(userHome),
  };
}

export function sameMachine(first: MachineIdentity, second: MachineIdentity): boolean {
  return (
    first.cpuModel === second.cpuModel &&
    first.kernelRelease === second.kernelRelease &&
    first.homeDevice === second.homeDevice
  );
}

export function baselineFileIn(dataHome: string): string {
  return path.join(dataHome, BASELINE_FILE_NAME);
}

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function probeBaselineOf(samples: readonly ProbeSample[]): ProbeBaseline {
  return { medianMs: medianOf(samples.map((sample) => sample.ms)), samples };
}

function isInsideWindow(sample: ProbeSample, now: Date): boolean {
  return now.getTime() - Date.parse(sample.at) <= SAMPLE_WINDOW_MILLISECONDS;
}

function recentProbeBaseline(probe: ProbeBaseline, now: Date): ProbeBaseline {
  return probeBaselineOf(probe.samples.filter((sample) => isInsideWindow(sample, now)));
}

export function keepRecentSamples(baseline: PressureBaseline, now: Date): PressureBaseline {
  return {
    ...baseline,
    probes: { git: recentProbeBaseline(baseline.probes.git, now), disk: recentProbeBaseline(baseline.probes.disk, now) },
  };
}

export interface TakenRound extends ProbeTimes {
  readonly at: Date;
}

export function baselineFromRounds(
  machine: MachineIdentity,
  rounds: readonly TakenRound[],
  formedUnderLoadReason?: string,
): PressureBaseline {
  return {
    version: BASELINE_FILE_VERSION,
    machine,
    formedUnderLoad: formedUnderLoadReason !== undefined,
    ...(formedUnderLoadReason === undefined ? {} : { formedUnderLoadReason }),
    probes: {
      git: probeBaselineOf(rounds.map((round) => ({ ms: round.gitMs, at: round.at.toISOString() }))),
      disk: probeBaselineOf(rounds.map((round) => ({ ms: round.diskMs, at: round.at.toISOString() }))),
    },
  };
}

export function baselineFromSamples(
  machine: MachineIdentity,
  rounds: readonly ProbeTimes[],
  now: Date,
  formedUnderLoadReason?: string,
): PressureBaseline {
  return baselineFromRounds(machine, rounds.map((round) => ({ ...round, at: now })), formedUnderLoadReason);
}

export function withSamplesAdded(
  baseline: PressureBaseline | undefined,
  machine: MachineIdentity,
  times: ProbeTimes,
  now: Date,
): PressureBaseline {
  if (baseline === undefined || !sameMachine(baseline.machine, machine)) {
    return baselineFromSamples(machine, [times], now);
  }
  const at = now.toISOString();
  return {
    ...baseline,
    probes: {
      git: probeBaselineOf([...baseline.probes.git.samples, { ms: times.gitMs, at }]),
      disk: probeBaselineOf([...baseline.probes.disk.samples, { ms: times.diskMs, at }]),
    },
  };
}

function isPressureBaseline(candidate: unknown): candidate is PressureBaseline {
  const baseline = candidate as Partial<PressureBaseline> | null;
  return (
    baseline?.version === BASELINE_FILE_VERSION &&
    typeof baseline.machine?.cpuModel === "string" &&
    Array.isArray(baseline.probes?.git?.samples) &&
    Array.isArray(baseline.probes?.disk?.samples)
  );
}

export async function readBaseline(dataHome: string): Promise<PressureBaseline | undefined> {
  const recorded = await readTextFileIfPresent(baselineFileIn(dataHome));
  if (recorded === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(recorded);
    return isPressureBaseline(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeBaseline(dataHome: string, baseline: PressureBaseline, now: Date): Promise<PressureBaseline> {
  const recent = keepRecentSamples(baseline, now);
  const baselineFile = baselineFileIn(dataHome);
  await mkdir(dataHome, { recursive: true });
  const temporaryFile = `${baselineFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(recent, null, 2)}\n`, "utf8");
  await rename(temporaryFile, baselineFile);
  return recent;
}
