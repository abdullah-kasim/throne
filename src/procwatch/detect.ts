import { formatDuration, processAgeSeconds } from '../process-inspection/process-age.ts';
import type { SampledProcess } from '../process-inspection/cpu-sampling.ts';
import { rollUpProcessTrees, type ProcessTree } from './tree-rollup.ts';
import { classifyOwnership, type OwnershipVerdict } from './classify.ts';

/** The Lord's 2-hour age threshold. With an hourly cadence, worst-case waste
 *  is (threshold + one interval) x burn rate. The threshold does the real
 *  work; the cadence only bounds the tail. A closed decision, not a knob. */
export const STUCK_AGE_THRESHOLD_SECONDS = 2 * 60 * 60;

/**
 * Cores' worth of CPU, summed across a family, below which a family is
 * simply idle. Deliberately LOW: magnitude is NOT the discriminator (Lord's
 * ruling 6) — this threshold exists only to exclude idle processes, and the
 * PROGRESS test does the discriminating. A process at 50% of a core for 20
 * hours is still 10 core-hours wasted, and a near-full-core rule would have
 * ignored it outright.
 *
 * Per CORE, never per machine (ruling 8): one fully stuck process is 100% of
 * a core but only 8% of this 12-core box, so any threshold that divided by
 * core count would have missed the 55-hour orphan that caused this
 * objective. Nothing in this module divides by core count.
 */
export const STUCK_CPU_FRACTION_THRESHOLD = 0.05;

/**
 * Cores' worth of CPU that makes a process worth pulling into a family at
 * all. Without this the roll-up is unbounded and every user process on the
 * box lands in ONE family under a common ancestor — measured live on this
 * host: 458 members, 622% of a core, and "every member stalled" trivially
 * false, so the sweep silently reports nothing. That is the dangerous
 * direction of failure, because a false negative announces itself as a
 * healthy machine.
 *
 * Idle processes are pruned; a zero-CPU process is still kept when it is an
 * ANCESTOR of an active one, which is exactly the `/bin/sh -c npm ci` and
 * `timeout` wrapper shape ruling 7 exists for.
 */
export const FAMILY_MEMBER_MIN_CPU_FRACTION = 0.01;

export interface ProcessRecord {
  pid: number;
  startTicks: number;
  ageSeconds: number;
  ageText: string;
  cpuFraction: number;
  state: string;
  cwd: string;
  cwdDeleted: boolean;
  cmdline: string;
  cgroup?: string;
  stdoutTarget?: string;
  ownership: OwnershipVerdict;
}

/** A whole family handed to the investigator, never a lone pid. */
export interface StuckTreeCandidate {
  root: ProcessRecord;
  members: ProcessRecord[];
  treeCpuFraction: number;
  ageSeconds: number;
  ageText: string;
}

export interface DetectInputs {
  sampled: readonly SampledProcess[];
  /** Overridable only so a live probe can exercise the discriminator against
   *  seconds-old processes of its own. Production never passes it. */
  ageThresholdSeconds?: number;
  neverTouchPids: ReadonlySet<number>;
  bootTimeEpochSeconds: number | undefined;
  nowEpochSeconds: number;
  clockTicksPerSecond: number;
  liveAgentNames: ReadonlySet<string>;
  registeredAgentNames: ReadonlySet<string>;
  home?: string;
  worktreesRoot?: string;
}

export interface DetectResult {
  /** Families to hand an investigator: old enough, burning something, and
   *  making NO forward progress. */
  stuckTrees: StuckTreeCandidate[];
  /** Processes working inside a worktree whose owning agent is neither live
   *  nor registered. Not investigation candidates — they are typically at
   *  zero CPU — but nothing else in the court watches them, because
   *  `no-idling` inspects agents and these agents no longer exist. */
  orphans: ProcessRecord[];
}

function toRecord(
  sample: SampledProcess,
  ageSeconds: number,
  ownership: OwnershipVerdict,
): ProcessRecord {
  const { snapshot } = sample;
  return {
    pid: snapshot.pid,
    startTicks: snapshot.startTicks,
    ageSeconds,
    ageText: formatDuration(ageSeconds),
    cpuFraction: sample.cpuFraction,
    state: snapshot.state,
    cwd: snapshot.cwd ?? '(unreadable)',
    cwdDeleted: snapshot.cwdDeleted ?? false,
    cmdline: snapshot.cmdline,
    ...(snapshot.cgroup === undefined ? {} : { cgroup: snapshot.cgroup }),
    ...(snapshot.stdoutTarget === undefined ? {} : { stdoutTarget: snapshot.stdoutTarget }),
    ownership,
  };
}

/**
 * A family is stuck when it burns measurable CPU while advancing NOTHING.
 * `unknown` progress on any member blocks the verdict: an unreadable
 * `/proc/<pid>/io` is missing evidence, and calling missing evidence
 * "stalled" would ask the Regent to buy an Opus investigation for every
 * process this user cannot inspect.
 */
function treeIsStuck(tree: ProcessTree): boolean {
  if (tree.treeCpuFraction < STUCK_CPU_FRACTION_THRESHOLD) return false;
  if (tree.members.some((member) => member.progress === 'unknown')) return false;
  return tree.members.every((member) => member.progress === 'stalled');
}

/**
 * The processes worth forming families from: everything actively burning,
 * plus the ancestors that connect them within the considered set. See
 * `FAMILY_MEMBER_MIN_CPU_FRACTION` for why an unfiltered roll-up is not
 * merely wasteful but silently wrong.
 */
export function familyMembers(considered: readonly SampledProcess[]): SampledProcess[] {
  const byPid = new Map(considered.map((sample) => [sample.snapshot.pid, sample]));
  const keep = new Set<number>();
  for (const sample of considered) {
    if (sample.cpuFraction < FAMILY_MEMBER_MIN_CPU_FRACTION) continue;
    keep.add(sample.snapshot.pid);
    let cursor = byPid.get(sample.snapshot.ppid);
    const guard = new Set<number>([sample.snapshot.pid]);
    while (cursor !== undefined && !guard.has(cursor.snapshot.pid)) {
      guard.add(cursor.snapshot.pid);
      keep.add(cursor.snapshot.pid);
      cursor = byPid.get(cursor.snapshot.ppid);
    }
  }
  return considered.filter((sample) => keep.has(sample.snapshot.pid));
}

export function detectOffenders(inputs: DetectInputs): DetectResult {
  const ageThreshold = inputs.ageThresholdSeconds ?? STUCK_AGE_THRESHOLD_SECONDS;
  const ages = new Map<number, number>();
  const ownerships = new Map<number, OwnershipVerdict>();
  const considered: SampledProcess[] = [];
  const orphans: ProcessRecord[] = [];

  for (const sample of inputs.sampled) {
    const { snapshot } = sample;
    if (inputs.neverTouchPids.has(snapshot.pid)) continue;
    const ageSeconds = processAgeSeconds(
      snapshot,
      inputs.bootTimeEpochSeconds,
      inputs.nowEpochSeconds,
      inputs.clockTicksPerSecond,
    );
    // An unknown age must not become a zero age (brand new, exempt) or an
    // infinite one (everything is an offender).
    if (ageSeconds === undefined) continue;
    const ownership = classifyOwnership({
      cwd: snapshot.cwd,
      liveAgentNames: inputs.liveAgentNames,
      registeredAgentNames: inputs.registeredAgentNames,
      ...(inputs.home === undefined ? {} : { home: inputs.home }),
      ...(inputs.worktreesRoot === undefined ? {} : { worktreesRoot: inputs.worktreesRoot }),
    });
    ages.set(snapshot.pid, ageSeconds);
    ownerships.set(snapshot.pid, ownership);
    // Every survivor joins the roll-up, young ones included: a stuck old
    // parent commonly holds a young child, and excluding the child would
    // lose exactly the CPU that identifies the family.
    considered.push(sample);
    if (ageSeconds >= ageThreshold && ownership.orphaned) {
      orphans.push(toRecord(sample, ageSeconds, ownership));
    }
  }

  const stuckTrees = rollUpProcessTrees(familyMembers(considered)).flatMap((tree) => {
    const rootAge = ages.get(tree.root.snapshot.pid);
    if (rootAge === undefined || rootAge < ageThreshold) return [];
    if (!treeIsStuck(tree)) return [];
    const members = tree.members.map((member) =>
      toRecord(member, ages.get(member.snapshot.pid) ?? 0, ownerships.get(member.snapshot.pid)!),
    );
    return [
      {
        root: toRecord(tree.root, rootAge, ownerships.get(tree.root.snapshot.pid)!),
        members,
        treeCpuFraction: tree.treeCpuFraction,
        ageSeconds: rootAge,
        ageText: formatDuration(rootAge),
      },
    ];
  });

  const stuckPids = new Set(
    stuckTrees.flatMap((tree) => tree.members.map((member) => member.pid)),
  );
  return {
    stuckTrees: stuckTrees.sort((left, right) => right.treeCpuFraction - left.treeCpuFraction),
    // A process already named inside a stuck family is not reported twice; a
    // duplicate entry teaches the reader to skim.
    orphans: orphans.filter((orphan) => !stuckPids.has(orphan.pid)),
  };
}
