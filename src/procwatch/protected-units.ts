import { execFile } from 'node:child_process';
import { PROTECTED_UNIT_NAMES } from './never-touch.ts';

export interface ProtectedUnitFacts {
  commands: string[];
  pids: number[];
}

export type RunSystemctlShow = (unitName: string) => Promise<string>;

export const REAL_RUN_SYSTEMCTL_SHOW: RunSystemctlShow = (unitName) =>
  new Promise((resolve, reject) => {
    execFile(
      'systemctl',
      ['--user', 'show', '-p', 'ExecStart', '-p', 'MainPID', unitName],
      { encoding: 'utf8', timeout: 10_000 },
      // eslint-disable-next-line promise/prefer-await-to-callbacks
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });

/**
 * Parses `systemctl show -p ExecStart -p MainPID` output. `ExecStart=` is
 * rendered as `{ path=... ; argv[]=<command line> ; ... }`, so the command
 * line is the ` ; `-delimited field after `argv[]=` -- not the `path=`
 * field, which for both protected units is a bare interpreter
 * (`/usr/bin/bash`, `.../bin/node`) and would match half the process table.
 */
export function parseSystemctlShow(stdout: string): ProtectedUnitFacts {
  const commands: string[] = [];
  const pids: number[] = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('MainPID=')) {
      const pid = Number(line.slice('MainPID='.length).trim());
      if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
      continue;
    }
    if (!line.startsWith('ExecStart=')) continue;
    const marker = line.indexOf('argv[]=');
    if (marker === -1) continue;
    const tail = line.slice(marker + 'argv[]='.length);
    const end = tail.indexOf(' ; ');
    const command = (end === -1 ? tail : tail.slice(0, end)).trim();
    if (command.length > 0) commands.push(command);
  }
  return { commands, pids };
}

/**
 * The protected units' live identity. A unit that cannot be interrogated
 * contributes nothing rather than failing the whole resolution -- but if
 * NONE of them resolve, `resolveNeverTouchPids` refuses the tick outright,
 * which is where that decision belongs.
 */
export async function resolveProtectedUnitFacts(
  run: RunSystemctlShow = REAL_RUN_SYSTEMCTL_SHOW,
  unitNames: readonly string[] = PROTECTED_UNIT_NAMES,
): Promise<ProtectedUnitFacts> {
  const perUnit = await Promise.all(
    unitNames.map(async (unitName) => {
      try {
        return parseSystemctlShow(await run(unitName));
      } catch {
        return { commands: [], pids: [] };
      }
    }),
  );
  return {
    commands: perUnit.flatMap((facts) => facts.commands),
    pids: perUnit.flatMap((facts) => facts.pids),
  };
}
