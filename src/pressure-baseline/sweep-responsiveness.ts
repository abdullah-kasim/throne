import { readMachineQuiet, type QuietReading } from "./machine-quiet.ts";
import { currentMachine, readBaseline, withSamplesAdded, writeBaseline } from "./pressure-baseline-store.ts";
import { probeResponsiveness } from "./responsiveness-probes.ts";
import { compareToBaseline, formatResponsivenessLine, probeFailureReport } from "./responsiveness-report.ts";

export interface ResponsivenessSweepContext {
  readonly dataHome: string;
  readonly userHome: string;
  readonly readQuiet?: () => QuietReading;
}

async function sweepLine(context: ResponsivenessSweepContext): Promise<string> {
  const quiet = (context.readQuiet ?? readMachineQuiet)();
  const times = await probeResponsiveness(context.dataHome, context.userHome);
  const machine = await currentMachine(context.userHome);
  const baseline = await readBaseline(context.dataHome);
  const now = new Date();
  const line = formatResponsivenessLine(compareToBaseline(times, baseline, machine, now));
  if (!quiet.quiet) return `${line}; samples not added: ${quiet.reason}`;
  await writeBaseline(context.dataHome, withSamplesAdded(baseline, machine, times, now), now);
  return `${line}; samples added to the baseline`;
}

export async function sweepResponsiveness(context: ResponsivenessSweepContext): Promise<string> {
  try {
    return await sweepLine(context);
  } catch (error) {
    return formatResponsivenessLine(probeFailureReport(error));
  }
}
