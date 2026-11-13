import {
  parseLsofCwdRecords,
  readProcessTable,
  type ProcessRow,
  type RunHostCommand,
} from './darwin-process-scan.ts';
import { isPathWithin } from './path-containment.ts';
import {
  DEFAULT_CLOCK_TICKS_PER_SECOND,
  DEFAULT_PROC_ROOT,
  listProcessSnapshots,
  readBootTimeEpochSeconds,
  readProcessIdentity,
} from './proc-scan.ts';

const MILLISECONDS_PER_SECOND = 1000;

export interface ProcessTableRead {
  readonly rows: readonly ProcessRow[];
  readonly pidsInDirectory: (directory: string) => Promise<ReadonlySet<number>>;
}

export type ReadProcessTable = (runHostCommand: RunHostCommand) => Promise<ProcessTableRead>;

function pidsWithCwdIn(cwdByPid: ReadonlyMap<number, string>, directory: string): Set<number> {
  return new Set([...cwdByPid].filter(([, cwd]) => isPathWithin(cwd, directory)).map(([pid]) => pid));
}

async function readDarwinCwds(runHostCommand: RunHostCommand): Promise<Map<number, string>> {
  return parseLsofCwdRecords(await runHostCommand('lsof', ['-a', '-d', 'cwd', '-Fpn']));
}

export const readDarwinProcessTable: ReadProcessTable = async (runHostCommand) => {
  const rows = await readProcessTable(runHostCommand);
  let cwdByPid: Promise<Map<number, string>> | undefined;
  return {
    rows,
    pidsInDirectory: async (directory) => {
      cwdByPid ??= readDarwinCwds(runHostCommand);
      return pidsWithCwdIn(await cwdByPid, directory);
    },
  };
};

export async function readLinuxProcessTable(procRoot: string = DEFAULT_PROC_ROOT): Promise<ProcessTableRead> {
  const [processes, bootSeconds] = await Promise.all([
    listProcessSnapshots(procRoot, readProcessIdentity),
    readBootTimeEpochSeconds(procRoot),
  ]);
  const rows = processes.map((snapshot): ProcessRow => ({
    pid: snapshot.pid,
    parentPid: snapshot.ppid,
    processGroupId: snapshot.processGroupId,
    command: snapshot.cmdline,
    ...(bootSeconds === undefined
      ? {}
      : { startedAt: Math.round((bootSeconds + snapshot.startTicks / DEFAULT_CLOCK_TICKS_PER_SECOND) * MILLISECONDS_PER_SECOND) }),
  }));
  const cwdByPid = new Map(processes.flatMap((snapshot) => snapshot.cwd === undefined ? [] : [[snapshot.pid, snapshot.cwd] as const]));
  return { rows, pidsInDirectory: async (directory) => pidsWithCwdIn(cwdByPid, directory) };
}

export const REAL_READ_PROCESS_TABLE: ReadProcessTable = process.platform === 'darwin'
  ? readDarwinProcessTable
  : () => readLinuxProcessTable();
