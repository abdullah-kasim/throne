import { readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import type { ScratchDirHolder, ScratchHolderIndex } from './tmp-scratch-lifecycle.types.ts';

const PROC_ROOT = '/proc';
const NUMERIC_PID_PATTERN = /^\d+$/;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errnoCode(error: unknown): string | undefined {
  return isErrnoException(error) ? error.code : undefined;
}

async function listProcPids(procRoot: string): Promise<number[]> {
  const entries = await readdir(procRoot);
  return entries
    .filter((entry) => NUMERIC_PID_PATTERN.test(entry))
    .map((entry) => Number.parseInt(entry, 10));
}

const NO_EVIDENCE_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM']);

type SymlinkReadResult =
  | { status: 'resolved'; target: string }
  | { status: 'no-evidence' }
  | { status: 'ambiguous' };

/**
 * Reads one `/proc` symlink (a process's `cwd`, or one of its `fd/N`
 * entries) and classifies the outcome. `no-evidence` covers the routine
 * cases — the process exited between listing pids and reading its link
 * (`ENOENT`), or it's owned by another user our own Unix permissions bar
 * us from inspecting (`EACCES`/`EPERM`), which carries no evidence either
 * way. Any other, genuinely unexpected failure is real ambiguity.
 */
async function readSymlinkTarget(linkPath: string): Promise<SymlinkReadResult> {
  try {
    const target = await readlink(linkPath);
    return { status: 'resolved', target: path.resolve(target) };
  } catch (error) {
    const code = errnoCode(error);
    if (code !== undefined && NO_EVIDENCE_ERROR_CODES.has(code)) {
      return { status: 'no-evidence' };
    }
    return { status: 'ambiguous' };
  }
}

async function symlinkHoldsDirectory(
  linkPath: string,
  resolvedDirPath: string,
): Promise<boolean> {
  const result = await readSymlinkTarget(linkPath);
  if (result.status === 'no-evidence') return false;
  // Ambiguous: fails safe toward "held".
  if (result.status === 'ambiguous') return true;
  return (
    result.target === resolvedDirPath ||
    result.target.startsWith(`${resolvedDirPath}${path.sep}`)
  );
}

type FdListResult =
  | { status: 'listed'; fdNames: string[] }
  | { status: 'no-evidence' }
  | { status: 'ambiguous' };

async function listProcessFileDescriptors(
  procRoot: string,
  pid: number,
): Promise<FdListResult> {
  try {
    return { status: 'listed', fdNames: await readdir(`${procRoot}/${pid}/fd`) };
  } catch (error) {
    const code = errnoCode(error);
    if (code !== undefined && NO_EVIDENCE_ERROR_CODES.has(code)) {
      return { status: 'no-evidence' };
    }
    return { status: 'ambiguous' };
  }
}

async function processCwdHoldsDirectory(
  procRoot: string,
  pid: number,
  resolvedDirPath: string,
): Promise<boolean> {
  return symlinkHoldsDirectory(`${procRoot}/${pid}/cwd`, resolvedDirPath);
}

async function processFileDescriptorHoldsDirectory(
  procRoot: string,
  pid: number,
  resolvedDirPath: string,
): Promise<boolean> {
  const listing = await listProcessFileDescriptors(procRoot, pid);
  if (listing.status === 'no-evidence') return false;
  // Ambiguous: fails safe toward "held".
  if (listing.status === 'ambiguous') return true;
  for (const fdName of listing.fdNames) {
    const holds = await symlinkHoldsDirectory(
      `${procRoot}/${pid}/fd/${fdName}`,
      resolvedDirPath,
    );
    if (holds) return true;
  }
  return false;
}

async function readProcessCommand(procRoot: string, pid: number): Promise<string | null> {
  try {
    return (await readFile(`${procRoot}/${pid}/comm`, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function processHoldsDirectory(
  procRoot: string,
  pid: number,
  resolvedDirPath: string,
): Promise<boolean> {
  if (await processCwdHoldsDirectory(procRoot, pid, resolvedDirPath)) return true;
  return processFileDescriptorHoldsDirectory(procRoot, pid, resolvedDirPath);
}

/**
 * Returns every OS process — named, unnamed, herdr-registered or not —
 * that currently has `dirPath` (or a path beneath it) as its cwd or an
 * open file descriptor. Genuinely ambiguous entries (unexpected read
 * failures, not the routine "process exited" or "owned by someone else"
 * cases) are included rather than skipped: any real doubt resolves
 * toward "holds it".
 *
 * This does a complete `/proc` walk (every live pid; per pid, `cwd` +
 * every `fd`). It is the fresh, unconditional check `removeScratchDir`'s
 * `preDeleteCheck`/`postKillCheck` always run immediately before a
 * deletion decision — callers scanning many candidate directories should
 * use `buildScratchHolderIndex` as a once-per-sweep pre-filter instead of
 * calling this once per directory.
 */
export async function findScratchDirHolders(
  dirPath: string,
  procRoot: string = PROC_ROOT,
): Promise<ScratchDirHolder[]> {
  const resolvedDirPath = path.resolve(dirPath);
  const pids = await listProcPids(procRoot);
  const holders: ScratchDirHolder[] = [];
  for (const pid of pids) {
    if (await processHoldsDirectory(procRoot, pid, resolvedDirPath)) {
      holders.push({ pid, command: await readProcessCommand(procRoot, pid) });
    }
  }
  return holders;
}

async function collectSymlinkTarget(linkPath: string, into: Set<string>): Promise<boolean> {
  const result = await readSymlinkTarget(linkPath);
  if (result.status === 'ambiguous') return false;
  if (result.status === 'resolved') into.add(result.target);
  return true;
}

async function collectPidFileDescriptorTargets(
  procRoot: string,
  pid: number,
  into: Set<string>,
): Promise<boolean> {
  const listing = await listProcessFileDescriptors(procRoot, pid);
  if (listing.status === 'no-evidence') return true;
  if (listing.status === 'ambiguous') return false;
  let allResolved = true;
  for (const fdName of listing.fdNames) {
    const resolved = await collectSymlinkTarget(`${procRoot}/${pid}/fd/${fdName}`, into);
    if (!resolved) allResolved = false;
  }
  return allResolved;
}

async function collectPidHeldTargets(
  procRoot: string,
  pid: number,
  into: Set<string>,
): Promise<boolean> {
  const cwdResolved = await collectSymlinkTarget(`${procRoot}/${pid}/cwd`, into);
  const fdResolved = await collectPidFileDescriptorTargets(procRoot, pid, into);
  return cwdResolved && fdResolved;
}

/**
 * Builds a once-per-sweep snapshot of every path a live process currently
 * holds under `/proc` — the pre-filter `checkScratchDirRemovalEligibility`
 * consults instead of running a full `/proc` walk for every candidate
 * directory. A total failure to list pids, or any per-pid read failure
 * that isn't the routine "exited" / "foreign-owned" case, marks the whole
 * snapshot `reliable: false` rather than silently under-reporting holders
 * for just the affected pid — this index only ever narrows the *skip*
 * path, so an unreliable snapshot must clear nothing.
 */
export async function buildScratchHolderIndex(
  procRoot: string = PROC_ROOT,
): Promise<ScratchHolderIndex> {
  let pids: number[];
  try {
    pids = await listProcPids(procRoot);
  } catch {
    return { reliable: false, heldPaths: new Set() };
  }
  const heldPaths = new Set<string>();
  let reliable = true;
  for (const pid of pids) {
    if (!(await collectPidHeldTargets(procRoot, pid, heldPaths))) {
      reliable = false;
    }
  }
  return { reliable, heldPaths };
}

/**
 * True only when `index` proves `dirPath` has zero chance of being held —
 * nothing in the snapshot resolves at or under it. This is a fast-path
 * skip *out* of the expensive per-directory walk, never a substitute for
 * the fresh `findScratchDirHolders` call a real deletion decision makes.
 */
export function indexClearsDirectory(index: ScratchHolderIndex, dirPath: string): boolean {
  if (!index.reliable) return false;
  const resolvedDirPath = path.resolve(dirPath);
  for (const heldPath of index.heldPaths) {
    if (
      heldPath === resolvedDirPath ||
      heldPath.startsWith(`${resolvedDirPath}${path.sep}`)
    ) {
      return false;
    }
  }
  return true;
}
