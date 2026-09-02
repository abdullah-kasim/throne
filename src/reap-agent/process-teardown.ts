import { listProcessesUnderPath, type ProcessUnderPath } from '../process-inspection/proc-scan.ts';
import { killScratchDirHolders } from '../tmp-scratch-lifecycle/kill-scratch-dir-holders.ts';
import { KILL_OUTCOMES, type ScratchDirHolderKillResult } from '../tmp-scratch-lifecycle/tmp-scratch-lifecycle.types.ts';
import { errorText } from '../shared-policy/error-text.ts';
import { resolveWorktreePath } from './occupancy.ts';
import type {
  ReapDeps,
  ReapRequest,
  WorktreeProcessTeardownResult,
} from './reap-agent.types.ts';

export interface WorktreeProcessTeardownDeps {
  /** Live processes whose resolved cwd is inside the given worktree path. */
  listProcessesUnderPath: (targetPath: string) => Promise<ProcessUnderPath[]>;
  /** SIGTERM, then SIGKILL after a bounded wait, for exactly these pids. */
  killProcesses: (pids: readonly number[]) => Promise<ScratchDirHolderKillResult[]>;
  /** Pids this teardown must never signal — the reaping process itself and
   *  its ancestors, which can legitimately be running inside the very tree
   *  being torn down (a Regent invoking `reap-agent` from a worktree). */
  protectedPids: ReadonlySet<number>;
}

export const REAL_WORKTREE_PROCESS_TEARDOWN_DEPS: WorktreeProcessTeardownDeps = {
  listProcessesUnderPath: (targetPath) => listProcessesUnderPath(targetPath),
  killProcesses: (pids) => killScratchDirHolders(pids.map((pid) => ({ pid, command: null }))),
  protectedPids: new Set([process.pid, process.ppid]),
};

export function describeProcessTeardown(result: WorktreeProcessTeardownResult): string[] {
  const actions: string[] = [];
  if (result.killed.length > 0) {
    actions.push(
      `terminated ${result.killed.length} process(es) still working inside the worktree: ` +
        result.killed
          .map((entry) => `pid ${entry.pid} (${entry.outcome}) ${entry.cmdline.slice(0, 120)}`)
          .join('; '),
    );
  }
  if (result.failed.length > 0) {
    actions.push(
      `FAILED to terminate ${result.failed.length} process(es) inside the worktree: ` +
        result.failed.map((entry) => `pid ${entry.pid} ${entry.cmdline.slice(0, 120)}`).join('; '),
    );
  }
  return actions;
}

/**
 * Terminates processes the agent being reaped still owns, identified by
 * WORKTREE CWD — never by pid guessing and never by process-name matching.
 * Ownership here is positive and narrow: the process's resolved cwd is
 * inside the exact worktree this teardown is about to remove, and that
 * worktree belongs to an agent the caller has already confirmed dead (the
 * live-agent and occupancy guards upstream of `executeTeardown` do that).
 *
 * `/proc/<pid>/cgroup` is read and reported for the audit trail but never
 * gates the decision: this codebase has no per-agent cgroup infrastructure,
 * so a cgroup-gated kill would match nothing and quietly do nothing.
 *
 * MUST run BEFORE the worktree directory is removed. Afterwards every
 * surviving process's `cwd` link points at a deleted inode, ownership can no
 * longer be resolved against a path that exists, and the orphan becomes
 * exactly the 55-hour `python3` this whole objective exists to prevent.
 */
export async function terminateWorktreeProcesses(
  worktreePath: string,
  deps: WorktreeProcessTeardownDeps = REAL_WORKTREE_PROCESS_TEARDOWN_DEPS,
): Promise<WorktreeProcessTeardownResult> {
  let processes: ProcessUnderPath[];
  try {
    processes = await deps.listProcessesUnderPath(worktreePath);
  } catch (error) {
    process.stderr.write(
      `reap-agent: could not enumerate processes inside "${worktreePath}" ` +
        `(${errorText(error)}) — continuing teardown without terminating any.\n`,
    );
    return { killed: [], failed: [] };
  }
  const owned = processes.filter((candidate) => !deps.protectedPids.has(candidate.pid));
  if (owned.length === 0) return { killed: [], failed: [] };
  const byPid = new Map(owned.map((candidate) => [candidate.pid, candidate]));
  const results = await deps.killProcesses(owned.map((candidate) => candidate.pid));
  const killed: WorktreeProcessTeardownResult['killed'] = [];
  const failed: WorktreeProcessTeardownResult['failed'] = [];
  for (const result of results) {
    const cmdline = byPid.get(result.pid)?.cmdline ?? '(unknown)';
    if (result.outcome === KILL_OUTCOMES.FAILED) {
      failed.push({ pid: result.pid, cmdline });
      continue;
    }
    if (result.outcome === KILL_OUTCOMES.ALREADY_GONE) continue;
    killed.push({ pid: result.pid, cmdline, outcome: result.outcome });
  }
  return { killed, failed };
}

/**
 * The `executeTeardown` seam: kills what the reaped agent left running inside
 * its own worktree, BEFORE `removeTree` deletes that worktree. Reaping tears
 * down the pane, the worktree, and the ledger, but has never terminated
 * background tasks the agent launched — which is how a `python3` under a
 * reaped Shadow's tree burned ~50 CPU-hours across 55 hours with nothing in
 * the court watching.
 *
 * A failure here is reported and never aborts teardown: leaving the agent
 * half-reaped because a signal failed would be a strictly worse state than an
 * orphan the hourly `procwatch` detector will name.
 */
export async function terminateReapedAgentProcesses(
  request: ReapRequest,
  deps: ReapDeps,
  actions: string[],
): Promise<void> {
  let treePath: string | undefined;
  try {
    treePath = await resolveWorktreePath(request.name, deps);
  } catch (error) {
    process.stderr.write(
      `reap-agent: cannot resolve "${request.name}"'s worktree path to terminate its ` +
        `remaining processes (${errorText(error)}) — continuing teardown.\n`,
    );
    return;
  }
  if (treePath === undefined) return;
  try {
    const result = await (
      deps.terminateWorktreeProcesses ?? terminateWorktreeProcesses
    )(treePath);
    actions.push(...describeProcessTeardown(result));
  } catch (error) {
    process.stderr.write(
      `reap-agent: terminating processes inside "${treePath}" failed ` +
        `(${errorText(error)}) — continuing teardown.\n`,
    );
  }
}
