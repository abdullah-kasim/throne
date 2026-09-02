import { readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { isPathWithin } from './path-containment.ts';
import { listProcessesUnderPathDarwin } from './darwin-process-scan.ts';

export const DEFAULT_PROC_ROOT = '/proc';

/**
 * Kernel clock ticks per second. Node exposes no `sysconf(_SC_CLK_TCK)`, and
 * `USER_HZ` has been fixed at 100 on Linux/x86-64 for the entire lifetime of
 * the ABI that `/proc/<pid>/stat` reports through -- it is part of that
 * ABI, not a tunable. Every caller takes it as a parameter anyway so a test
 * can prove the arithmetic without depending on the host.
 */
export const DEFAULT_CLOCK_TICKS_PER_SECOND = 100;

export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  /** Single-letter scheduler state from `/proc/<pid>/stat` field 3 (`R`,
   *  `S`, `D`, `Z`, ...). `R` plus a near-full-core CPU delta is the stuck
   *  fingerprint the Lord's ruling names. */
  state: string;
  /** utime + stime in clock ticks: total CPU this process has consumed since
   *  it started. Only ever meaningful as a DELTA between two reads -- the
   *  lifetime figure is the misleading signal `ps %CPU` reports. */
  cpuTicks: number;
  /** Field 22: process start time, in clock ticks since boot. Combined with
   *  `pid` this is a collision-free process identity; a bare pid is not,
   *  because pids recycle. */
  startTicks: number;
  comm: string;
  cmdline: string;
  /** The cwd with any ` (deleted)` marker STRIPPED. The kernel appends that
   *  marker when the directory has been removed, and leaving it on breaks
   *  every path comparison downstream: a process whose live agent's tree was
   *  removed mid-flight would stop matching that agent's roster cwd and
   *  silently lose its never-touch protection, and the derived worktree-owner
   *  name would carry the marker as part of the agent's name. */
  cwd?: string;
  /** Target of `/proc/<pid>/fd/1` — the file the process's stdout is wired
   *  to. For an agent-launched task that is the harness task file, which
   *  names the OWNING CAMPAIGN even after the agent is reaped and its
   *  worktree removed: `cwd` names the worktree, `fd/1` names the task, and
   *  only together do they identify an orphan whose tree is already gone. */
  stdoutTarget?: string;
  /** `syscr` + `syscw` from `/proc/<pid>/io`: total read and write syscalls
   *  this process has issued. Their DELTA across a sample window is the
   *  forward-progress signal — a spinner shows exactly zero of each while
   *  burning CPU, where a live compile shows dozens. `undefined` when
   *  `/proc/<pid>/io` is unreadable, which is UNKNOWN progress and must
   *  never be read as "no progress". */
  ioSyscalls?: { readonly reads: number; readonly writes: number };
  /** `VmRSS` in kB from `/proc/<pid>/status`: the second progress signal,
   *  independent of syscalls. A process doing pure in-memory work with no
   *  syscalls still moves its resident set; a spinner does not. */
  vmRssKb?: number;
  /** True when the kernel reported the cwd as deleted — the strongest
   *  possible orphan evidence, kept as a field rather than smuggled into the
   *  path string. */
  cwdDeleted?: boolean;
  cgroup?: string;
}

const DELETED_MARKER = ' (deleted)';

export function stripDeletedMarker(linkTarget: string): {
  path: string;
  deleted: boolean;
} {
  return linkTarget.endsWith(DELETED_MARKER)
    ? { path: linkTarget.slice(0, -DELETED_MARKER.length), deleted: true }
    : { path: linkTarget, deleted: false };
}

function isPidDirectoryName(entryName: string): boolean {
  return /^\d+$/.test(entryName);
}

async function listCandidatePids(procRoot: string): Promise<number[]> {
  const entries = await readdir(procRoot);
  return entries.filter(isPidDirectoryName).map((entry) => Number(entry));
}

/**
 * Parses one `/proc/<pid>/stat` line. The `comm` field is parenthesised and
 * may itself contain spaces and parentheses, so the only safe split point is
 * the LAST `)` -- splitting the whole line on whitespace misparses any
 * process whose executable name contains a space, and silently shifts every
 * numeric field after it.
 */
export function parseProcStat(
  line: string,
): Pick<ProcessSnapshot, 'pid' | 'ppid' | 'state' | 'cpuTicks' | 'startTicks' | 'comm'> | undefined {
  const openParen = line.indexOf('(');
  const closeParen = line.lastIndexOf(')');
  if (openParen === -1 || closeParen === -1 || closeParen < openParen) return undefined;
  const pid = Number(line.slice(0, openParen).trim());
  const comm = line.slice(openParen + 1, closeParen);
  const rest = line.slice(closeParen + 2).trim().split(/\s+/);
  // `rest[0]` is stat field 3, so field N lives at `rest[N - 3]`.
  const state = rest[0];
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const startTicks = Number(rest[19]);
  if (
    !Number.isFinite(pid) ||
    state === undefined ||
    !Number.isFinite(ppid) ||
    !Number.isFinite(utime) ||
    !Number.isFinite(stime) ||
    !Number.isFinite(startTicks)
  ) {
    return undefined;
  }
  return { pid, ppid, state, cpuTicks: utime + stime, startTicks, comm };
}

function numericFieldAfter(text: string, label: string): number | undefined {
  const line = text.split('\n').find((candidate) => candidate.startsWith(`${label}:`));
  if (line === undefined) return undefined;
  const value = Number(line.slice(label.length + 1).trim().split(/\s+/)[0]);
  return Number.isFinite(value) ? value : undefined;
}

/** `syscr`/`syscw` from `/proc/<pid>/io`. Returns `undefined` unless BOTH
 *  are present: a half-read io file cannot support a progress verdict, and
 *  defaulting the missing half to zero would manufacture "no progress". */
export function parseProcIo(
  text: string,
): { readonly reads: number; readonly writes: number } | undefined {
  const reads = numericFieldAfter(text, 'syscr');
  const writes = numericFieldAfter(text, 'syscw');
  return reads === undefined || writes === undefined ? undefined : { reads, writes };
}

/** `VmRSS` in kB from `/proc/<pid>/status`. Absent for a kernel thread, which
 *  has no resident set at all — `undefined`, not zero. */
export function parseVmRssKb(text: string): number | undefined {
  return numericFieldAfter(text, 'VmRSS');
}

/**
 * Seconds since boot at which the machine started, from `/proc/stat`'s
 * `btime` line (which is a UNIX epoch second, despite the name). Needed to
 * turn a process's boot-relative `startTicks` into a wall-clock age.
 */
export async function readBootTimeEpochSeconds(
  procRoot: string = DEFAULT_PROC_ROOT,
): Promise<number | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(procRoot, 'stat'), 'utf8');
  } catch {
    return undefined;
  }
  const line = text.split('\n').find((candidate) => candidate.startsWith('btime '));
  if (line === undefined) return undefined;
  const seconds = Number(line.slice('btime '.length).trim());
  return Number.isFinite(seconds) ? seconds : undefined;
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

async function readOptionalLink(linkPath: string): Promise<string | undefined> {
  try {
    return await readlink(linkPath);
  } catch {
    return undefined;
  }
}

/**
 * One process's full snapshot, or `undefined` when the process exited between
 * the directory listing and this read -- a routine race during any `/proc`
 * walk, never an error. `cwd` and `cgroup` are best-effort: a process owned
 * by another user is listed with its stat fields and no cwd, which is the
 * honest record (we cannot see it) rather than a silent omission.
 */
export async function readProcessSnapshot(
  pid: number,
  procRoot: string = DEFAULT_PROC_ROOT,
): Promise<ProcessSnapshot | undefined> {
  const pidRoot = path.join(procRoot, String(pid));
  const statText = await readOptional(path.join(pidRoot, 'stat'));
  if (statText === undefined) return undefined;
  const parsed = parseProcStat(statText.trim());
  if (parsed === undefined) return undefined;
  const [cwd, cgroup, cmdlineRaw, stdout, ioText, statusText] = await Promise.all([
    readOptionalLink(path.join(pidRoot, 'cwd')),
    readOptional(path.join(pidRoot, 'cgroup')),
    readOptional(path.join(pidRoot, 'cmdline')),
    readOptionalLink(path.join(pidRoot, 'fd', '1')),
    readOptional(path.join(pidRoot, 'io')),
    readOptional(path.join(pidRoot, 'status')),
  ]);
  const ioSyscalls = ioText === undefined ? undefined : parseProcIo(ioText);
  const vmRssKb = statusText === undefined ? undefined : parseVmRssKb(statusText);
  const cmdline = (cmdlineRaw ?? '').split('\0').filter((part) => part.length > 0).join(' ');
  const resolvedCwd = cwd === undefined ? undefined : stripDeletedMarker(cwd);
  return {
    ...parsed,
    cmdline: cmdline.length > 0 ? cmdline : parsed.comm,
    ...(resolvedCwd === undefined
      ? {}
      : { cwd: resolvedCwd.path, cwdDeleted: resolvedCwd.deleted }),
    ...(cgroup === undefined ? {} : { cgroup: cgroup.trim() }),
    ...(stdout === undefined
      ? {}
      : { stdoutTarget: stripDeletedMarker(stdout).path }),
    ...(ioSyscalls === undefined ? {} : { ioSyscalls }),
    ...(vmRssKb === undefined ? {} : { vmRssKb }),
  };
}

/** Every live process readable from `procRoot`, exit races skipped. */
export async function listProcessSnapshots(
  procRoot: string = DEFAULT_PROC_ROOT,
): Promise<ProcessSnapshot[]> {
  const pids = await listCandidatePids(procRoot);
  const snapshots = await Promise.all(
    pids.map((pid) => readProcessSnapshot(pid, procRoot)),
  );
  return snapshots.filter((snapshot): snapshot is ProcessSnapshot => snapshot !== undefined);
}

export interface ProcessUnderPath {
  pid: number;
  cwd: string;
  cwdDeleted: boolean;
  cgroup?: string;
  cmdline: string;
}

/**
 * Live processes whose resolved `cwd` is `targetPath` itself or a path
 * beneath it -- enumerated from `procRoot`'s own directory listing, never
 * from a trusted pid input. `cgroup` is recorded for the audit trail and
 * NEVER gates inclusion: this codebase has no per-agent cgroup
 * infrastructure, so a cgroup-gated decision would silently match nothing.
 *
 * On darwin there is no `/proc` to list, so the same question is answered by
 * `lsof`/`ps` in `darwin-process-scan.ts`; before that existed, reap-agent's
 * teardown found nothing to terminate on a Mac and every leftover process
 * under a reaped worktree survived. `platform` is a parameter only so tests
 * can exercise the Linux fixture path on any host.
 */
export async function listProcessesUnderPath(
  targetPath: string,
  procRoot: string = DEFAULT_PROC_ROOT,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessUnderPath[]> {
  if (platform === 'darwin') return listProcessesUnderPathDarwin(targetPath);
  const snapshots = await listProcessSnapshots(procRoot);
  return snapshots.flatMap((snapshot) => {
    if (snapshot.cwd === undefined) return [];
    if (!isPathWithin(snapshot.cwd, targetPath)) return [];
    return [
      {
        pid: snapshot.pid,
        cwd: snapshot.cwd,
        cwdDeleted: snapshot.cwdDeleted ?? false,
        cmdline: snapshot.cmdline,
        ...(snapshot.cgroup === undefined ? {} : { cgroup: snapshot.cgroup }),
      },
    ];
  });
}
