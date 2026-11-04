import { CPU_PRESSURE_PATH, MEMORY_PRESSURE_PATH, type CapacityPressureSources } from "../keep-going/keep-going-pressure-report.ts";
import {
  readDarwinCpuPressure,
  readDarwinIoPressure,
  readDarwinMemoryPressure,
} from "../pressure-signal/darwin-pressure-reader.ts";
import { readLinuxDiskBusyPressure } from "../pressure-signal/linux-disk-busy-reader.ts";
import { readPsiPressure, type PsiReading } from "../pressure-signal/psi-pressure-reader.ts";

export const NOT_QUIET_SUFFIX = "the machine is not quiet";

export type QuietReading = { readonly quiet: true } | { readonly quiet: false; readonly reason: string };

export type QuietSources = Pick<
  CapacityPressureSources,
  "platform" | "cpuPath" | "memoryPath" | "disk" | "sampleDarwinCpus" | "sleepDuringDarwinCpuSample" | "readDarwinSysctl"
>;

export interface QuietInputs {
  readonly cpu: PsiReading;
  readonly disk: PsiReading;
  readonly memory: PsiReading;
}

interface QuietInput {
  readonly name: keyof QuietInputs;
  readonly stallLabel: string;
  readonly quietBelowPercent: number;
}

const QUIET_INPUTS: readonly QuietInput[] = [
  { name: "cpu", stallLabel: "cpu stall", quietBelowPercent: 5 },
  { name: "disk", stallLabel: "disk busy", quietBelowPercent: 5 },
  { name: "memory", stallLabel: "memory stall", quietBelowPercent: 1 },
];

function shortNumber(value: number): number {
  return Number(value.toFixed(1));
}

function whyInputIsNotQuiet(input: QuietInput, reading: PsiReading): string | undefined {
  if (reading.state === "unknown") return `${input.name} pressure unreadable`;
  if (reading.avg60 < input.quietBelowPercent) return undefined;
  return `${input.stallLabel} ${shortNumber(reading.avg60)}%`;
}

export function judgeQuiet(inputs: QuietInputs): QuietReading {
  const reasons = QUIET_INPUTS.map((input) => whyInputIsNotQuiet(input, inputs[input.name])).filter(
    (reason) => reason !== undefined,
  );
  if (reasons.length === 0) return { quiet: true };
  return { quiet: false, reason: `${reasons.join(", ")} — ${NOT_QUIET_SUFFIX}` };
}

export function readQuietInputs(sources: Partial<QuietSources> = {}): QuietInputs {
  if ((sources.platform ?? process.platform) === "darwin") {
    return {
      cpu: readDarwinCpuPressure(sources.sampleDarwinCpus, sources.sleepDuringDarwinCpuSample),
      disk: readDarwinIoPressure(),
      memory: readDarwinMemoryPressure(sources.readDarwinSysctl),
    };
  }
  return {
    cpu: readPsiPressure(sources.cpuPath ?? CPU_PRESSURE_PATH),
    disk: readLinuxDiskBusyPressure(sources.disk),
    memory: readPsiPressure(sources.memoryPath ?? MEMORY_PRESSURE_PATH),
  };
}

export function readMachineQuiet(sources: Partial<QuietSources> = {}): QuietReading {
  return judgeQuiet(readQuietInputs(sources));
}
