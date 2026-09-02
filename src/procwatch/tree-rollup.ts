import type { SampledProcess } from '../process-inspection/cpu-sampling.ts';

/**
 * One process family, rolled up. Evaluating lone pids misses the shape that
 * actually occurs: the wedged `npm ci` found on 2026-08-20 was a
 * `/bin/sh -c npm ci` PARENT plus its child, each individually below any
 * sane CPU threshold and therefore invisible one pid at a time. Worse, the
 * obvious per-pid sampling picks the WRONG member — sampling a `timeout`
 * wrapper (state S, zero CPU) instead of its spinning child yields a
 * confident all-clear, which was hit live while proving these rulings.
 */
export interface ProcessTree {
  root: SampledProcess;
  members: SampledProcess[];
  /** Sum of the family's CPU, in cores. Summed because the wedge is a
   *  property of the family, not of whichever member happens to hold the
   *  cycles this second. Per CORE, never divided by core count. */
  treeCpuFraction: number;
}

/**
 * Groups sampled processes into families under their topmost ancestor that
 * is itself in the candidate set. A process whose parent is absent from the
 * set — because the parent is never-touch, or already exited — becomes its
 * own root, which keeps a live agent's excluded harness from dragging its
 * children into a family the sweep must not evaluate.
 */
export function rollUpProcessTrees(candidates: readonly SampledProcess[]): ProcessTree[] {
  const byPid = new Map(candidates.map((sample) => [sample.snapshot.pid, sample]));
  const rootOf = new Map<number, number>();

  function resolveRoot(pid: number, seen: Set<number>): number {
    const cached = rootOf.get(pid);
    if (cached !== undefined) return cached;
    const sample = byPid.get(pid);
    // A cycle cannot occur in a real process table, but a fixture (or a
    // torn read across two samples) can produce one; stopping at the repeat
    // keeps this total rather than hanging the hourly tick.
    if (sample === undefined || seen.has(pid)) return pid;
    seen.add(pid);
    const parent = sample.snapshot.ppid;
    const root = byPid.has(parent) ? resolveRoot(parent, seen) : pid;
    rootOf.set(pid, root);
    return root;
  }

  const families = new Map<number, SampledProcess[]>();
  for (const sample of candidates) {
    const root = resolveRoot(sample.snapshot.pid, new Set());
    const members = families.get(root) ?? [];
    members.push(sample);
    families.set(root, members);
  }

  return [...families.entries()].flatMap(([rootPid, members]) => {
    const root = byPid.get(rootPid);
    if (root === undefined) return [];
    return [
      {
        root,
        members: members.sort((left, right) => left.snapshot.pid - right.snapshot.pid),
        treeCpuFraction: members.reduce((total, member) => total + member.cpuFraction, 0),
      },
    ];
  });
}
