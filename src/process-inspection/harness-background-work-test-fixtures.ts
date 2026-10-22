import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { HerdrPaneProcessInfo } from '../herdr/herdr-inventory.service.ts';
import { listProcessesUnderPathDarwin, parseProcessTable, type RunHostCommand } from './darwin-process-scan.ts';
import type { HarnessBackgroundWorkHost } from './harness-background-work.ts';

const PROCESS_TABLES_DIRECTORY = path.join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'process-tables');
const FIXTURE_HARNESS_PID = 52785;

export async function processTableCapture(name: string): Promise<string> {
  return readFile(path.join(PROCESS_TABLES_DIRECTORY, `${name}.txt`), 'utf8');
}

function paneProcessInfo(paneId: string, harnessDirectory: string, processTable: string): HerdrPaneProcessInfo {
  const harnessGroup = parseProcessTable(processTable)
    .filter((row) => row.processGroupId === FIXTURE_HARNESS_PID);
  return {
    paneId,
    foregroundProcesses: harnessGroup.map((row) => {
      const argv = row.command.split(/\s+/);
      return { name: path.basename(argv[0]!), argv, cwd: harnessDirectory, pid: row.pid };
    }),
  };
}

function lsofCwdRecords(cwdByPid: ReadonlyMap<number, string>): string {
  return [...cwdByPid].flatMap(([pid, cwd]) => [`p${pid}`, 'fcwd', `n${cwd}`]).join('\n');
}

export function harnessProcessHost(fixture: {
  readonly processTable: string;
  readonly harnessDirectory: string;
  readonly pidsInHarnessDirectory?: readonly number[];
}): HarnessBackgroundWorkHost & { readonly hostCommands: string[] } {
  const hostCommands: string[] = [];
  const table = parseProcessTable(fixture.processTable);
  const cwdByPid = new Map(table.map((row) => [row.pid, '/']));
  const harness = table.find((row) => row.pid === FIXTURE_HARNESS_PID);
  const paneShellAndHarnessGroup = table
    .filter((row) => row.processGroupId === FIXTURE_HARNESS_PID || row.pid === harness?.parentPid)
    .map((row) => row.pid);
  for (const pid of [...paneShellAndHarnessGroup, ...(fixture.pidsInHarnessDirectory ?? [])]) {
    cwdByPid.set(pid, fixture.harnessDirectory);
  }
  const runHostCommand: RunHostCommand = async (file, args) => {
    hostCommands.push([file, ...args].join(' '));
    if (file === 'lsof') return lsofCwdRecords(cwdByPid);
    if (args.includes('pid=,args=')) {
      return parseProcessTable(fixture.processTable).map((row) => `${row.pid} ${row.command}`).join('\n');
    }
    return fixture.processTable;
  };
  return {
    hostCommands,
    readPaneProcessInfo: async (paneId) => paneProcessInfo(paneId, fixture.harnessDirectory, fixture.processTable),
    runHostCommand,
    listProcessesUnderPath: (directory) => listProcessesUnderPathDarwin(directory, runHostCommand),
  };
}

export const PROCESS_HOST_WITHOUT_HERDR: HarnessBackgroundWorkHost = {
  readPaneProcessInfo: async (paneId) => {
    throw new Error(`herdr pane process-info --pane ${paneId} failed: server not running`);
  },
  runHostCommand: async (file) => {
    throw new Error(`${file} is not available`);
  },
  listProcessesUnderPath: async () => [],
};
