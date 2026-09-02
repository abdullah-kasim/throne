// macOS answer to `listProcessesUnderPath`: which live processes have their
// cwd inside a given directory. Linux answers from `/proc/<pid>/cwd`; macOS
// has no /proc, so the reap-agent teardown (and through it the autoreap
// cron) silently found NOTHING to terminate under a reaped agent's worktree
// on this host — the exact orphan class `process-teardown.ts` exists to
// prevent, reintroduced by platform. The Lord's order of 2026-09-02: every
// autoscaler-family signal supports both Linux and mac.
//
// Sources, both stock on macOS:
//   lsof -a -d cwd -Fpn   one `p<pid>` / `fcwd` / `n<path>` record per
//                          process whose cwd this user may see
//   ps -axo pid=,args=     the command line, for the audit trail only
//
// `lsof` lists only processes the caller may inspect; a foreign-owner
// process is simply absent, which mirrors the Linux path's "no cwd, not
// matched" and is the honest record. `(deleted)` has no macOS equivalent
// in this output, so `cwdDeleted` is always false here.

import { execFile } from 'node:child_process';
import { isPathWithin } from './path-containment.ts';
import type { ProcessUnderPath } from './proc-scan.ts';

export type RunHostCommand = (
  file: string,
  args: readonly string[],
) => Promise<string>;

export const REAL_RUN_HOST_COMMAND: RunHostCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
      // eslint-disable-next-line promise/prefer-await-to-callbacks
      (error, stdout) => {
        // lsof exits 1 whenever ANY listed process could not be fully
        // inspected, which on a multi-user host is always; its stdout is
        // still the complete answer for what it could see.
        if (error && typeof stdout !== 'string') {
          reject(error);
          return;
        }
        resolve(stdout ?? '');
      },
    );
  });

/** Parses `lsof -Fpn` records into pid -> cwd. A `p` line opens a record;
 *  the first `n` line after it is that process's cwd. */
export function parseLsofCwdRecords(output: string): Map<number, string> {
  const cwdByPid = new Map<number, string>();
  let currentPid: number | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      currentPid = Number.isInteger(pid) && pid > 0 ? pid : undefined;
      continue;
    }
    if (line.startsWith('n') && currentPid !== undefined && !cwdByPid.has(currentPid)) {
      cwdByPid.set(currentPid, line.slice(1));
    }
  }
  return cwdByPid;
}

/** Parses `ps -axo pid=,args=` into pid -> command line. */
export function parsePsCommandLines(output: string): Map<number, string> {
  const commandByPid = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    commandByPid.set(Number(match[1]), match[2]!.trim());
  }
  return commandByPid;
}

export async function listProcessesUnderPathDarwin(
  targetPath: string,
  run: RunHostCommand = REAL_RUN_HOST_COMMAND,
): Promise<ProcessUnderPath[]> {
  const [lsofOutput, psOutput] = await Promise.all([
    run('lsof', ['-a', '-d', 'cwd', '-Fpn']),
    run('ps', ['-axo', 'pid=,args=']),
  ]);
  const cwdByPid = parseLsofCwdRecords(lsofOutput);
  const commandByPid = parsePsCommandLines(psOutput);
  const matches: ProcessUnderPath[] = [];
  for (const [pid, cwd] of cwdByPid) {
    if (!isPathWithin(cwd, targetPath)) continue;
    matches.push({
      pid,
      cwd,
      cwdDeleted: false,
      cmdline: commandByPid.get(pid) ?? '(command line unavailable)',
    });
  }
  return matches.sort((left, right) => left.pid - right.pid);
}
