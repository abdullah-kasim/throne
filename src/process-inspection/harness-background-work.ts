import type { HerdrPaneProcessInfo } from '../herdr/herdr-inventory.service.ts';
import { harnessProcessOf, isHarnessCommandLine } from '../herdr/herdr-process-detection.ts';
import { getPaneProcessInfo } from '../herdr/herdr-runtime.service.ts';
import {
  readProcessTable,
  REAL_RUN_HOST_COMMAND,
  type ProcessRow,
  type RunHostCommand,
} from './darwin-process-scan.ts';
import { listProcessesUnderPath, type ProcessUnderPath } from './proc-scan.ts';

export const HARNESS_BACKGROUND_WORK_KINDS = {
  RUNNING: 'running',
  NONE: 'none',
  UNKNOWN: 'unknown',
} as const;

export type HarnessBackgroundWork =
  | { readonly kind: typeof HARNESS_BACKGROUND_WORK_KINDS.RUNNING; readonly description: string }
  | { readonly kind: typeof HARNESS_BACKGROUND_WORK_KINDS.NONE }
  | { readonly kind: typeof HARNESS_BACKGROUND_WORK_KINDS.UNKNOWN };

export interface HarnessBackgroundWorkHost {
  readonly readPaneProcessInfo: (paneId: string) => Promise<HerdrPaneProcessInfo>;
  readonly runHostCommand: RunHostCommand;
  readonly listProcessesUnderPath: (directory: string) => Promise<ProcessUnderPath[]>;
}

export const REAL_HARNESS_BACKGROUND_WORK_HOST: HarnessBackgroundWorkHost = {
  readPaneProcessInfo: getPaneProcessInfo,
  runHostCommand: REAL_RUN_HOST_COMMAND,
  listProcessesUnderPath: (directory) => listProcessesUnderPath(directory),
};

const DESCRIBED_PROCESS_LIMIT = 3;
const DESCRIBED_COMMAND_LENGTH = 80;
const NO_BACKGROUND_WORK: HarnessBackgroundWork = { kind: HARNESS_BACKGROUND_WORK_KINDS.NONE };
const UNREADABLE_BACKGROUND_WORK: HarnessBackgroundWork = { kind: HARNESS_BACKGROUND_WORK_KINDS.UNKNOWN };

class ProcessFamily {
  private readonly rowByPid: ReadonlyMap<number, ProcessRow>;

  constructor(table: readonly ProcessRow[]) {
    this.rowByPid = new Map(table.map((row) => [row.pid, row]));
  }

  row(pid: number): ProcessRow | undefined {
    return this.rowByPid.get(pid);
  }

  ancestorsOf(row: ProcessRow): ProcessRow[] {
    const ancestors: ProcessRow[] = [];
    const seen = new Set([row.pid]);
    let parent = this.rowByPid.get(row.parentPid);
    while (parent !== undefined && !seen.has(parent.pid)) {
      ancestors.push(parent);
      seen.add(parent.pid);
      parent = this.rowByPid.get(parent.parentPid);
    }
    return ancestors;
  }

  harnessPids(harness: ProcessRow): Set<number> {
    return new Set([harness.pid, ...[...this.rowByPid.values()]
      .filter((row) => isHarnessCommandLine(row.command))
      .map((row) => row.pid)]);
  }

  ancestorPidsOf(pids: ReadonlySet<number>): Set<number> {
    return new Set([...pids].flatMap((pid) => {
      const row = this.rowByPid.get(pid);
      return row === undefined ? [] : this.ancestorsOf(row).map((ancestor) => ancestor.pid);
    }));
  }
}

function isToolWorkOfHarness(
  row: ProcessRow,
  harness: ProcessRow,
  family: ProcessFamily,
  pidsInHarnessDirectory: ReadonlySet<number>,
): boolean {
  if (row.pid === harness.pid || isHarnessCommandLine(row.command)) return false;
  const ancestors = family.ancestorsOf(row);
  if (ancestors.some((ancestor) => ancestor.pid === harness.pid)) {
    return row.processGroupId !== harness.processGroupId;
  }
  if (!pidsInHarnessDirectory.has(row.pid)) return false;
  const harnessPids = family.harnessPids(harness);
  return !ancestors.some((ancestor) => harnessPids.has(ancestor.pid)) &&
    !family.ancestorPidsOf(harnessPids).has(row.pid);
}

function describeToolWork(toolWork: readonly ProcessRow[]): string {
  const commands = toolWork
    .slice(0, DESCRIBED_PROCESS_LIMIT)
    .map((row) => row.command.slice(0, DESCRIBED_COMMAND_LENGTH));
  const hidden = toolWork.length - commands.length;
  return [...commands, ...(hidden > 0 ? [`${hidden} more`] : [])].join('; ');
}

function backgroundWorkOf(toolWork: readonly ProcessRow[]): HarnessBackgroundWork {
  return toolWork.length === 0
    ? NO_BACKGROUND_WORK
    : { kind: HARNESS_BACKGROUND_WORK_KINDS.RUNNING, description: describeToolWork(toolWork) };
}

async function pidsInDirectory(directory: string | undefined, host: HarnessBackgroundWorkHost): Promise<Set<number>> {
  if (directory === undefined) return new Set();
  return new Set((await host.listProcessesUnderPath(directory)).map((process) => process.pid));
}

export async function readHarnessBackgroundWork(
  paneId: string,
  host: HarnessBackgroundWorkHost = REAL_HARNESS_BACKGROUND_WORK_HOST,
): Promise<HarnessBackgroundWork> {
  try {
    const harnessProcess = harnessProcessOf(await host.readPaneProcessInfo(paneId));
    if (harnessProcess?.pid === undefined) return UNREADABLE_BACKGROUND_WORK;
    const table = await readProcessTable(host.runHostCommand);
    const family = new ProcessFamily(table);
    const harness = family.row(harnessProcess.pid);
    if (harness === undefined) return UNREADABLE_BACKGROUND_WORK;
    const descendantWork = table.filter((row) => isToolWorkOfHarness(row, harness, family, new Set()));
    if (descendantWork.length > 0) return backgroundWorkOf(descendantWork);
    const pidsInHarnessDirectory = await pidsInDirectory(harnessProcess.cwd, host);
    return backgroundWorkOf(table.filter((row) => isToolWorkOfHarness(row, harness, family, pidsInHarnessDirectory)));
  } catch {
    return UNREADABLE_BACKGROUND_WORK;
  }
}
