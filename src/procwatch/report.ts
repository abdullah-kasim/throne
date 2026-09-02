import type { ContainerScanResult } from './container-scan.ts';
import type { ProcessRecord, StuckTreeCandidate } from './detect.ts';
import { offenderKey, type ReportLedger } from './report-ledger.ts';

/** The exact spawn the Regent is being asked to authorize, quoted in the
 *  request so the ask is unambiguous and does not require the reader to
 *  reconstruct it. This worker never runs it — spawning is the Regent's
 *  prerogative, as the 2026-08-19 ruling that excised Stager actuation from
 *  alpha-autoscale established. */
export const INVESTIGATOR_SPAWN_RECIPE =
  'create-agent --model opus --role Agent --non-campaign --bypass-model --bypass-preset-agent';

function ownershipText(offender: ProcessRecord): string {
  const parts: string[] = [offender.ownership.reapSafety];
  if (offender.ownership.worktreeOwner !== undefined) {
    parts.push(
      offender.ownership.orphaned
        ? `worktree of ${offender.ownership.worktreeOwner} (NO LIVE OWNER)`
        : `worktree of ${offender.ownership.worktreeOwner}`,
    );
  }
  return parts.join(', ');
}

function memberLines(member: ProcessRecord, marker: string): string {
  return (
    `  ${marker} pid ${member.pid} state=${member.state} age=${member.ageText} ` +
    `cpu=${Math.round(member.cpuFraction * 100)}% of a core\n` +
    `      cwd:    ${member.cwd}${member.cwdDeleted ? ' (ALREADY DELETED)' : ''}\n` +
    `      cgroup: ${member.cgroup ?? '(unreadable)'}\n` +
    `      fd/1:   ${member.stdoutTarget ?? '(unreadable)'}\n` +
    `      cmd:    ${member.cmdline.slice(0, 200)}\n` +
    `      class:  ${ownershipText(member)}`
  );
}

function candidateBlock(
  tree: StuckTreeCandidate,
  escalations: ReadonlySet<string>,
  ledger: ReportLedger,
): string {
  const key = offenderKey(tree.root);
  const previous = ledger[key];
  const escalation =
    escalations.has(key) && previous !== undefined
      ? ` [STILL ALIVE — raised ${previous.reportCount} time(s) since first sighting]`
      : '';
  // The whole family, never a lone pid: the wedged `npm ci` on 2026-08-20
  // was a `/bin/sh -c npm ci` parent plus its child, each individually below
  // any sane threshold and invisible one pid at a time.
  const members = tree.members
    .map((member) => memberLines(member, member.pid === tree.root.pid ? 'root ->' : 'child ->'))
    .join('\n');
  return (
    `- process family rooted at pid ${tree.root.pid}, ${tree.members.length} member(s), ` +
    `age ${tree.ageText}, family CPU ${Math.round(tree.treeCpuFraction * 100)}% of a core, ` +
    `ZERO forward progress across the sample window (no syscall and no VmRSS ` +
    `movement)${escalation}\n${members}`
  );
}

function containerSection(containers: ContainerScanResult): string {
  if (containers.state === 'unavailable') {
    return `Suite fixture containers: could not be scanned (${containers.reason}).`;
  }
  if (containers.aged.length === 0) {
    return `Suite fixture containers: ${containers.total} present, none newly past the age threshold.`;
  }
  const lines = containers.aged.map((container) => `- ${container.name} up ${container.ageText}`);
  return (
    `Suite fixture containers: ${containers.aged.length} of ${containers.total} past the age ` +
    `threshold (report only — their teardown belongs to another objective):\n${lines.join('\n')}`
  );
}

function candidateSection(
  candidates: readonly StuckTreeCandidate[],
  escalations: ReadonlySet<string>,
  ledger: ReportLedger,
): string {
  if (candidates.length === 0) return 'No new stuck process families this tick.';
  const blocks = candidates
    .map((tree) => candidateBlock(tree, escalations, ledger))
    .join('\n');
  return (
    `Please launch an Opus-level investigator for ${candidates.length} process ` +
    `${candidates.length === 1 ? 'family' : 'families'} that look stuck. Each is past the 2h ` +
    `age threshold, burning measurable CPU (a live /proc/<pid>/stat delta, never lifetime ` +
    `%CPU, and per CORE rather than per machine), and advancing NOTHING — magnitude is not ` +
    `the discriminator, absence of progress is:\n${blocks}\n\n` +
    `Spawn recipe for each: ${INVESTIGATOR_SPAWN_RECIPE}\n` +
    `The investigator answers ONE question — is this process killable — from ` +
    `/proc/<pid>/cwd, /proc/<pid>/cgroup and /proc/<pid>/fd/1, and kills only what it has ` +
    `positively proven killable.`
  );
}

function orphanSection(orphans: readonly ProcessRecord[]): string {
  if (orphans.length === 0) return '';
  const lines = orphans.map(
    (offender) =>
      `- pid ${offender.pid} age=${offender.ageText} owner=${offender.ownership.worktreeOwner} ` +
      `cwd=${offender.cwd}${offender.cwdDeleted ? ' (ALREADY DELETED)' : ''}\n` +
      `    fd/1: ${offender.stdoutTarget ?? '(unreadable)'}  cmd: ${offender.cmdline.slice(0, 120)}`,
  );
  return (
    `\n\nSeparately, and NOT an investigation request: ${orphans.length} process(es) are ` +
    `working inside a worktree whose owning agent is neither live nor registered. They are ` +
    `not burning CPU, so they are not stuck-CPU candidates — but nothing else in the court ` +
    `watches them, because no-idling inspects agents and these agents no longer exist:\n` +
    `${lines.join('\n')}`
  );
}

/**
 * The single hourly notice. It is a REQUEST FOR A JUDGEMENT, not a verdict:
 * detection is mechanical and cheap, while deciding whether a process is
 * genuinely wedged or a legitimate long-running job is judgement, and
 * judgement is what gets the expensive model. Nothing in this file, or in
 * the worker that calls it, kills or spawns anything.
 */
export function buildProcwatchRequest(
  candidates: readonly StuckTreeCandidate[],
  orphans: readonly ProcessRecord[],
  escalations: ReadonlySet<string>,
  ledger: ReportLedger,
  containers: ContainerScanResult,
): string {
  return (
    `${candidateSection(candidates, escalations, ledger)}` +
    `${orphanSection(orphans)}\n\n${containerSection(containers)}\n\n` +
    'procwatch found and reported. It killed nothing, spawned nothing, and decided nothing ' +
    'about killability — a "reap-safe" class means the cwd is a work tree, not that the ' +
    'process is provably dead work.'
  );
}
