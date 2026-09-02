// Per-sweep evidence assembly for `IdleFamilyEvidence` -- every roster-derived
// field `findFullyIdleFamilies` reads is computed exactly once here and
// reused by every family/member that references the same agent, instead of
// re-derived per lookup.
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import {
  IdentityLineReadStatus,
  type IdentityLineRead,
} from '../agentdata/identity-data.service.ts';
import { isAlphaRole, spawnedAtAgeMs } from './idle-family.ts';
import type { NoIdlingDependencies } from './no-idling-dependencies.types.ts';

/**
 * The tristate supervisor read for every roster entry -- kept as the full
 * `IdentityLineRead` rather than collapsed to a string, so an unresolved
 * read stays distinguishable from a genuinely absent supervisor field for
 * every downstream consumer (`idle-family.ts`), and so this map itself IS
 * the record of which entries had an unresolved read, per
 * `agent_docs/MEMORY/TRISTATE_UNKNOWN_IS_NEVER_EMPTY_LAW.md`'s "must say so
 * in its own verdict" obligation -- no separate diagnostic set is needed
 * when the evidence already carries the distinction losslessly.
 */
export async function readSupervisors(
  roster: readonly AgentStatusesRosterEntry[],
  dataDir: string,
  readAgentSupervisor: NoIdlingDependencies['readAgentSupervisor'],
): Promise<ReadonlyMap<string, IdentityLineRead>> {
  const supervisors = new Map<string, IdentityLineRead>();
  for (const entry of roster) {
    supervisors.set(entry.name, await readAgentSupervisor(entry.name, dataDir));
  }
  return supervisors;
}

/**
 * Every live agent's age (ms since `spawn.json`'s `spawned_at`), evaluated
 * once per roster entry per sweep — the ONE place this domain decision is
 * made, reused by every family/member that references the same agent instead
 * of re-derived per lookup. Role-neutral (BGS-2): a just-spawned child is
 * exactly as indistinguishable-from-stalled as a just-spawned Alpha, and
 * children outnumber Alphas.
 */
export async function readAgentAges(
  roster: readonly AgentStatusesRosterEntry[],
  dataDir: string,
  readSpawnSpecFn: NoIdlingDependencies['readSpawnSpec'],
  now: () => number,
): Promise<ReadonlyMap<string, number>> {
  const ages = new Map<string, number>();
  const nowMs = now();
  for (const entry of roster) {
    const spec = await readSpawnSpecFn(entry.name, dataDir);
    const ageMs = spawnedAtAgeMs(spec?.spawned_at, nowMs);
    if (ageMs !== undefined) {
      ages.set(entry.name, ageMs);
    }
  }
  return ages;
}

/**
 * Names of non-Alpha roster members positively marked idle-by-design — a
 * receive-only canary carrying its own ledger marker file. Alphas are never
 * queried here — an Alpha always owns its own todo bundle by construction —
 * so this only ever narrows the CHILD side of a family.
 */
export async function readIdleByDesignChildren(
  roster: readonly AgentStatusesRosterEntry[],
  dataDir: string,
  isIdleByDesignFn: NoIdlingDependencies['isIdleByDesign'],
): Promise<ReadonlySet<string>> {
  const idleByDesign = new Set<string>();
  for (const entry of roster) {
    if (isAlphaRole(entry.role)) {
      continue;
    }
    if (await isIdleByDesignFn(entry.name, dataDir)) {
      idleByDesign.add(entry.name);
    }
  }
  return idleByDesign;
}

/**
 * Names of live-roster entries whose recorded `cwd` no longer exists on
 * disk — the evidence-assembly-layer filesystem check `IdleFamilyEvidence`'s
 * `cwdMissingNames` documents. An entry with no recorded `cwd` is never
 * counted as missing; there is nothing to check.
 */
export async function readCwdMissingNames(
  roster: readonly AgentStatusesRosterEntry[],
  checkCwdExistsFn: NoIdlingDependencies['checkCwdExists'],
): Promise<ReadonlySet<string>> {
  const missing = new Set<string>();
  for (const entry of roster) {
    if (entry.cwd === undefined) {
      continue;
    }
    if (!(await checkCwdExistsFn(entry.cwd))) {
      missing.add(entry.name);
    }
  }
  return missing;
}

/**
 * Names durable ledger evidence already accounts for as finished or torn
 * down -- the fs-backed evidence half of `IdleFamilyEvidence
 * .durablyAccountedForNames`, computed once per sweep and reused by every
 * family/member that references the same agent.
 */
export async function readDurablyAccountedForNames(
  roster: readonly AgentStatusesRosterEntry[],
  dataDir: string,
  isDurablyAccountedForFn: NoIdlingDependencies['isDurablyAccountedFor'],
): Promise<ReadonlySet<string>> {
  const accountedFor = new Set<string>();
  for (const entry of roster) {
    if (await isDurablyAccountedForFn(entry.name, dataDir)) {
      accountedFor.add(entry.name);
    }
  }
  return accountedFor;
}

/**
 * Recorded supervisor names carrying a live top-level ledger registration --
 * the fs-backed evidence half of `IdleFamilyEvidence.registeredAgentNames`.
 * Only supervisor names are checked (not the whole roster): this set exists
 * solely to confirm a recorded supervisor when its own roster row raced past
 * it, so checking every roster member would do filesystem work no caller
 * ever reads.
 */
export async function readRegisteredSupervisorNames(
  supervisors: ReadonlyMap<string, IdentityLineRead>,
  dataDir: string,
  isRegisteredAgentFn: NoIdlingDependencies['isRegisteredAgent'],
): Promise<ReadonlySet<string>> {
  const registered = new Set<string>();
  const supervisorNames = new Set(
    [...supervisors.values()]
      .filter((read) => read.status === IdentityLineReadStatus.Found)
      .map((read) => read.value),
  );
  for (const supervisorName of supervisorNames) {
    if (await isRegisteredAgentFn(supervisorName, dataDir)) {
      registered.add(supervisorName);
    }
  }
  return registered;
}
