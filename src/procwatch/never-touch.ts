import { isPathWithin } from '../process-inspection/path-containment.ts';
import type { ProcessSnapshot } from '../process-inspection/proc-scan.ts';

/**
 * The units the Lord left installed on 2026-08-19 when every other user unit
 * was deleted. Their `ExecStart=` command lines are resolved at runtime and
 * matched against live command lines -- the unit NAMES are only used to ask
 * systemd what those commands are.
 */
export const PROTECTED_UNIT_NAMES = [
  'throne-backend.service',
  'throne-herdr.service',
] as const;

export interface NeverTouchInputs {
  /** Every live process, from one `/proc` walk. */
  snapshots: readonly ProcessSnapshot[];
  /** `ExecStart=` command lines resolved from `PROTECTED_UNIT_NAMES`. Empty
   *  when systemd could not be asked -- which makes the sweep REFUSE, see
   *  `resolveNeverTouchPids`'s contract. */
  protectedCommands: readonly string[];
  /** `MainPID` of each protected unit, when systemd reports one. This is the
   *  exact, non-heuristic seed: `throne-herdr.service` runs
   *  `bash -lc exec .../herdr ...`, so its live process's command line does
   *  NOT contain the unit's `ExecStart=` string, and only the MainPID (plus
   *  the descendant closure below) protects it. */
  protectedPids: readonly number[];
  /** Recorded `cwd` of every agent live in the herdr roster right now. Any
   *  process working inside one of those directories is a live campaign's
   *  own process, whatever it is called. */
  liveAgentCwds: readonly string[];
  /** This sweep's own pid. Its ancestors and descendants are derived. */
  selfPid: number;
}

function ancestorPids(byPid: Map<number, ProcessSnapshot>, from: number): number[] {
  const chain: number[] = [];
  let cursor = byPid.get(from);
  const guard = new Set<number>();
  while (cursor !== undefined && cursor.ppid > 0 && !guard.has(cursor.pid)) {
    guard.add(cursor.pid);
    chain.push(cursor.ppid);
    cursor = byPid.get(cursor.ppid);
  }
  return chain;
}

function closeOverDescendants(
  snapshots: readonly ProcessSnapshot[],
  seeds: Set<number>,
): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const snapshot of snapshots) {
    const siblings = childrenByParent.get(snapshot.ppid) ?? [];
    siblings.push(snapshot.pid);
    childrenByParent.set(snapshot.ppid, siblings);
  }
  const closed = new Set(seeds);
  const pending = [...seeds];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    for (const child of childrenByParent.get(pid) ?? []) {
      if (closed.has(child)) continue;
      closed.add(child);
      pending.push(child);
    }
  }
  return closed;
}

export type NeverTouchResolution =
  | { readonly state: 'resolved'; readonly pids: ReadonlySet<number>; readonly seedCount: number }
  | { readonly state: 'unresolved'; readonly reason: string };

/**
 * The pids this sweep must never name as reapable, computed BEFORE any
 * cwd-based reap-safety classification runs -- never after. The ordering is
 * the whole point: `throne-backend`'s own `WorkingDirectory=` is
 * `<home>/repos/throne`, so naive cwd classification marks the
 * backend hosting this very worker, herdr, and every live agent harness as
 * "reap-safe". A sweep that proposes its own death is worse than no sweep.
 *
 * Three independent seeds, then the transitive descendant closure of all of
 * them (a wedged `npm ci` started BY a live agent is that agent's problem to
 * see, not an orphan to reclaim):
 *
 *  1. This process and everything below it (plus its ancestor chain,
 *     added flat -- see the closure note in the body).
 *  2. Each protected unit's `MainPID`, plus any process whose command line
 *     contains that unit's `ExecStart=` command -- both resolved from
 *     systemd, never a name-substring guess like "anything with 'throne' in
 *     it".
 *  3. Any process whose cwd is inside a live herdr-roster agent's cwd.
 *
 * Returns `unresolved` when the protected `ExecStart=` commands could not be
 * read at all. That is deliberate: with no protected-command seed the sweep
 * cannot prove it is excluding its own host, and reporting an offender list
 * it cannot vouch for is exactly how a bad kill decision gets invited
 * downstream. Refusing a tick is cheap; the next one is an hour away.
 */
export function resolveNeverTouchPids(inputs: NeverTouchInputs): NeverTouchResolution {
  if (inputs.protectedCommands.length === 0 && inputs.protectedPids.length === 0) {
    return {
      state: 'unresolved',
      reason:
        `could not resolve ExecStart=/MainPID for ${PROTECTED_UNIT_NAMES.join(', ')}; ` +
        'refusing to classify anything rather than risk naming this sweep\'s own host',
    };
  }
  const byPid = new Map(inputs.snapshots.map((snapshot) => [snapshot.pid, snapshot]));
  const seeds = new Set<number>([inputs.selfPid, ...inputs.protectedPids.filter((pid) => pid > 0)]);
  for (const snapshot of inputs.snapshots) {
    if (inputs.protectedCommands.some((command) => snapshot.cmdline.includes(command))) {
      seeds.add(snapshot.pid);
      continue;
    }
    if (
      snapshot.cwd !== undefined &&
      inputs.liveAgentCwds.some((cwd) => cwd.length > 0 && isPathWithin(snapshot.cwd!, cwd))
    ) {
      seeds.add(snapshot.pid);
    }
  }
  const pids = closeOverDescendants(inputs.snapshots, seeds);
  // Ancestors are added FLAT, deliberately without their descendant closure.
  // This sweep's ancestor chain ends at `systemd --user`, whose descendants
  // are every process this user owns -- closing over them would protect the
  // entire machine and leave the sweep unable to name anything at all.
  for (const ancestor of ancestorPids(byPid, inputs.selfPid)) pids.add(ancestor);
  return { state: 'resolved', pids, seedCount: seeds.size };
}
