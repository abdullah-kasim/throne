import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { RUNTIME_DATA_DIR } from '../shared-policy/runtime-data-home.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';

const DEFAULT_DATA_DIR = RUNTIME_DATA_DIR;
const SUPERVISOR_LINE_PREFIX = '- **Supervisor (routine):** ';
const STAGER_ROLE = 'Stager';

export const STALE_PROGRESS_MS = 45 * 60 * 1000;

export type StallReason =
  | 'blocked-alpha'
  | 'dead-child'
  | 'idle-child'
  | 'completed-child'
  | 'stale-working-alpha';

export interface StallSignature {
  readonly alpha: string;
  readonly child?: string;
  readonly reason: StallReason;
}

export interface StallEvidence {
  readonly roster: readonly AgentStatusesRosterEntry[];
  readonly supervisors: ReadonlyMap<string, string>;
  readonly staleAlphas: ReadonlySet<string>;
}

export interface FamilyRecoverySummary {
  readonly alpha: string;
  readonly signatures: readonly StallSignature[];
  readonly staleWorkingAlpha: boolean;
}

function isStagerRosterEntry(entry: AgentStatusesRosterEntry): boolean {
  return entry.role === STAGER_ROLE;
}

export function classifyStalls(evidence: StallEvidence): StallSignature[] {
  const alphas = new Set(
    evidence.roster
      .filter((entry) => entry.role === 'Alpha' && entry.lifecycle === 'live')
      .map((entry) => entry.name),
  );
  const signatures: StallSignature[] = [];

  for (const entry of evidence.roster) {
    if (isStagerRosterEntry(entry)) continue;

    if (entry.role === 'Alpha' && entry.lifecycle === 'live') {
      if (entry.liveStatus === 'blocked' && !entry.reportLanded) {
        signatures.push({ alpha: entry.name, reason: 'blocked-alpha' });
      } else if (
        entry.liveStatus === 'working' &&
        evidence.staleAlphas.has(entry.name)
      ) {
        signatures.push({ alpha: entry.name, reason: 'stale-working-alpha' });
      }
      continue;
    }

    if (entry.role !== 'Shadow') continue;
    const alpha = evidence.supervisors.get(entry.name);
    if (alpha === undefined || !alphas.has(alpha)) continue;
    if (entry.reportLanded) {
      signatures.push({ alpha, child: entry.name, reason: 'completed-child' });
    } else if (entry.lifecycle === 'dead') {
      signatures.push({ alpha, child: entry.name, reason: 'dead-child' });
    } else if (
      entry.lifecycle === 'live' &&
      (entry.liveStatus === 'idle' || entry.liveStatus === 'done')
    ) {
      signatures.push({ alpha, child: entry.name, reason: 'idle-child' });
    }
  }

  return signatures.sort((left, right) =>
    `${left.alpha}\0${left.child ?? ''}\0${left.reason}`.localeCompare(
      `${right.alpha}\0${right.child ?? ''}\0${right.reason}`,
    ),
  );
}

export function aggregateFamilyRecovery(
  evidence: StallEvidence,
): FamilyRecoverySummary[] {
  const families = new Map<string, StallSignature[]>();
  for (const signature of classifyStalls(evidence)) {
    const signatures = families.get(signature.alpha) ?? [];
    signatures.push(signature);
    families.set(signature.alpha, signatures);
  }
  for (const alpha of evidence.staleAlphas) {
    const signatures = families.get(alpha) ?? [];
    if (!signatures.some((signature) => signature.reason === 'stale-working-alpha')) {
      signatures.push({ alpha, reason: 'stale-working-alpha' });
    }
    families.set(alpha, signatures);
  }
  return [...families.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([alpha, signatures]) => ({
      alpha,
      signatures: signatures.sort((left, right) =>
        `${left.child ?? ''}\0${left.reason}`.localeCompare(
          `${right.child ?? ''}\0${right.reason}`,
        ),
      ),
      staleWorkingAlpha: evidence.staleAlphas.has(alpha),
    }));
}

async function newestMtimeMs(directory: string): Promise<number | null> {
  let newest: number | null = null;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await newestMtimeMs(candidate);
      if (nested !== null && (newest === null || nested > newest)) newest = nested;
    } else if (entry.isFile()) {
      const modified = (await stat(candidate)).mtimeMs;
      if (newest === null || modified > newest) newest = modified;
    }
  }
  return newest;
}

async function readAgentSupervisor(
  name: string,
  dataDir: string,
): Promise<string> {
  let body: string;
  try {
    body = await readFile(path.join(dataDir, name, 'identity.md'), 'utf8');
  } catch {
    return '';
  }
  const line = body
    .split('\n')
    .find((candidate) => candidate.startsWith(SUPERVISOR_LINE_PREFIX));
  return line?.slice(SUPERVISOR_LINE_PREFIX.length).trim() ?? '';
}

export async function readStallEvidence(
  roster: readonly AgentStatusesRosterEntry[],
  nowMs: number,
  dataDir: string = DEFAULT_DATA_DIR,
): Promise<StallEvidence> {
  const shadows = roster.filter((entry) => entry.role === 'Shadow');
  const supervisors = new Map(
    await Promise.all(
      shadows.map(async (entry) =>
        [entry.name, await readAgentSupervisor(entry.name, dataDir)] as const,
      ),
    ),
  );
  const workingAlphas = roster.filter(
    (entry) =>
      entry.role === 'Alpha' &&
      entry.lifecycle === 'live' &&
      entry.liveStatus === 'working',
  );
  const staleAlphas = new Set<string>();
  await Promise.all(
    workingAlphas.map(async (entry) => {
      const modified = await newestMtimeMs(path.join(dataDir, entry.name));
      if (modified !== null && nowMs - modified >= STALE_PROGRESS_MS) {
        staleAlphas.add(entry.name);
      }
    }),
  );
  return { roster, supervisors, staleAlphas };
}

export function stallInstruction(signature: StallSignature): string {
  const subject = signature.child ?? signature.alpha;
  return (
    `keep-going detected ${signature.reason} for ${subject}. ` +
    'Inspect the child result once, repair/resume ownership if needed, review and merge completed work, ' +
    'reap consumed children, then dispatch every dependency-ready next slice. Do not wait on coarse working status.'
  );
}

export function familyRecoveryInstruction(
  family: FamilyRecoverySummary,
): string {
  const details = family.signatures
    .map(
      (signature) =>
        `${signature.child ?? signature.alpha} (${signature.reason})`,
    )
    .join('; ');
  return (
    `keep-going detected recovery work for Alpha ${family.alpha}: ${details}. ` +
    'Inspect each child result once, repair/resume ownership if needed, review and merge completed work, ' +
    'reap consumed children, then dispatch every dependency-ready next slice. Do not wait on coarse working status.'
  );
}
