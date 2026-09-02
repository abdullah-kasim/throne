// `resource-pressure` -- render the throne's own capacity-pressure verdict
// (the pressure-signal domain the alpha-autoscale admission gate and
// keep-going report already consume) plus supplemental host telemetry, for a
// human or script asking "how loaded is the box right now?". Observe-and-
// report only: nothing here can launch, nudge, or reap anything.

import { readFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { readCapacityPressure } from '../keep-going/keep-going-pressure-report.ts';
import { readDarwinMemoryKib } from '../pressure-signal/darwin-pressure-reader.ts';
import {
  formatResourcePressureReport,
  parseMeminfoKib,
  parsePsiWindows,
  resourcePressureJson,
  type ResourcePressureSnapshot,
} from './resource-pressure-report.ts';

function readFileOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Collects the live snapshot. Every input degrades independently to
 * null/unknown rather than throwing: a container without /proc/pressure/io
 * still gets a verdict, and a broken verdict still gets load/memory context.
 * On darwin there are no PSI windows to show (the verdict came from the
 * darwin readers, and the report says so) and the memory line comes from
 * `hw.memsize` / `kern.memorystatus_level` instead of `/proc/meminfo`.
 */
export function collectResourcePressureSnapshot(
  platform: NodeJS.Platform = process.platform,
): ResourcePressureSnapshot {
  const source = platform === 'darwin' ? 'darwin' : 'psi';
  const psi = (name: string) => {
    if (source === 'darwin') return null;
    const content = readFileOrNull(`/proc/pressure/${name}`);
    return content === null ? null : parsePsiWindows(content);
  };
  const readMemory = () => {
    if (source === 'darwin') return readDarwinMemoryKib();
    const meminfo = readFileOrNull('/proc/meminfo');
    return meminfo === null
      ? { memTotalKib: null, memAvailableKib: null }
      : parseMeminfoKib(meminfo);
  };
  const { memTotalKib, memAvailableKib } = readMemory();
  const [avg1, avg5, avg15] = loadavg();
  return {
    source,
    classification: readCapacityPressure(),
    cpu: psi('cpu'),
    memory: psi('memory'),
    io: psi('io'),
    loadAverages: [avg1, avg5, avg15],
    cpuCount: availableParallelism(),
    memTotalKib,
    memAvailableKib,
  };
}

@Command({
  name: 'resource-pressure',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class ResourcePressureCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    const snapshot = collectResourcePressureSnapshot();
    if (passedParams.includes('--json')) {
      process.stdout.write(`${JSON.stringify(resourcePressureJson(snapshot))}\n`);
    } else {
      for (const line of formatResourcePressureReport(snapshot)) {
        process.stdout.write(`${line}\n`);
      }
    }
    // Reporting succeeded even when inputs were partial; partiality is stated
    // in the output, not converted into a failing exit.
    process.exitCode = 0;
  }
}
