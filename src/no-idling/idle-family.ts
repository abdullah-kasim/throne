import { sameAgentName } from '../herdr/herdr-identity-contracts.ts';
import { agentStatusAcceptsInput } from '../herdr/herdr-inventory.service.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import {
  resolvedSupervisorName,
  supervisorReadUnresolved,
} from './idle-family-supervisor-read.ts';
import type { LastMessageTagState } from './idle-pane-tag-classification.ts';
import type {
  FullyIdleFamily,
  IdleFamilyEvidence,
} from './idle-family-evidence.types.ts';

export { resolvedSupervisorName } from './idle-family-supervisor-read.ts';
export type {
  FullyIdleFamily,
  IdleFamilyEvidence,
} from './idle-family-evidence.types.ts';

export const NO_IDLING_REGENT_NAME = 'Regent';
export const NO_IDLING_ALPHA_ROLE = 'Alpha';
// A stager's entire point is sitting idle for hours waiting on the Lord —
// the report's consumer (the Regent) acts on what it contains (nudge/reap),
// and either action against a live stager destroys or interrupts a live
// Lord conversation. Excluded the same way NO_IDLING_REGENT_NAME is: before
// an entry is considered as any kind of report item at all.
export const NO_IDLING_STAGER_ROLE = 'Stager';

// Defense in depth alongside the read/write-boundary casing fixes in
// `agent-statuses-registry.ts`'s `readAgentStatusRole` and
// `identity-data.service.ts`'s `writeIdentity`: identity.md's own
// `- **Role:** ` line has been observed carrying inconsistent casing for the
// same semantic role, so every role check in this module goes through one
// shared case-insensitive predicate rather than a per-site `===` a
// differently-cased read silently defeats.
function roleMatches(role: string | undefined, canonicalRole: string): boolean {
  return role?.toLowerCase() === canonicalRole.toLowerCase();
}

export function isAlphaRole(role: string | undefined): boolean {
  return roleMatches(role, NO_IDLING_ALPHA_ROLE);
}

export function isStagerRole(role: string | undefined): boolean {
  return roleMatches(role, NO_IDLING_STAGER_ROLE);
}

export type { LastMessageTagState } from './idle-pane-tag-classification.ts';
export {
  classifyLastMessageTags,
  classifyReapabilityAwareLastMessageTags,
  lastMessageBlock,
  liveBackgroundWork,
} from './idle-pane-tag-classification.ts';

// Milliseconds since `spawn.json`'s `spawned_at` timestamp, or undefined when
// the timestamp is missing or unparseable — the same computation
// `throne-startup-reconciliation.service.ts` uses for its own registration-age
// floor. An Alpha this cannot be measured for gains no age-based protection or
// penalty; it falls through to the pre-existing status/pane-tag judgment.
export function spawnedAtAgeMs(
  spawnedAt: string | undefined,
  nowMs: number,
): number | undefined {
  if (spawnedAt === undefined) return undefined;
  const spawnedAtMs = Date.parse(spawnedAt);
  return Number.isNaN(spawnedAtMs) ? undefined : nowMs - spawnedAtMs;
}

// The no-idling sweep runs every minute against the live court. Measured
// 2026-08-11 (QUEUE.md ESCALATED subsection): alpha-cag-complete-agent-gate
// was flagged by the sweep "seconds after spawn while still BOOTING," and
// repeated operator observation puts ordinary agent boot time at "about a
// minute." 90s is a safety margin above that observed ~60s boot time, not a
// lab-instrumented millisecond figure — the sweep's own per-minute
// granularity does not need finer precision than that.
//
// Role-neutral and shared: originally Alpha-only (`ALPHA_MIN_AGE_MS`), but a
// freshly-spawned CHILD reading its own ASSIGNMENT.md is exactly as
// indistinguishable-from-stalled as a freshly-spawned Alpha, and children
// outnumber Alphas — observed live 2026-08-11 (shadow-dsr2-99b flagged 9s
// after spawn, mid-first-turn). Same floor, one constant, both roles (BGS-2).
export const AGENT_MIN_AGE_MS = 90_000;

// Explicit predicate so "no live children" and "children, all idle" are two
// distinct, separately named cases instead of an emergent property of
// `.every` on a possibly-empty array (see the call site for why zero must
// not pass).
function allChildrenIdle(children: readonly AgentStatusesRosterEntry[]): boolean {
  return children.length > 0 && children.every(isIdleStatus);
}

/**
 * `children.length === 0` (the post-filter set `allChildrenIdle` refuses to
 * vacuously pass) is reached by TWO structurally different roster shapes,
 * and they mean opposite things:
 *
 *  - RAW children exist (this Alpha genuinely has live descendants right
 *    now) but every one of them got excluded by the age floor, the
 *    idle-by-design marker, or a landed REPORT.md. That exclusion means
 *    real activity is in flight (a just-spawned child still booting, a
 *    canary that is supposed to sit idle, a completed Shadow awaiting
 *    merge) — the family must stay silent exactly as before this function
 *    existed (BGS-5/alpha-bgs5-vacuous-idle).
 *  - NO raw children exist at all. This is the state `allChildrenIdle`'s
 *    guard could never tell apart from the one above, so it always fell
 *    through the same door: a childless Alpha was NEVER even considered for
 *    the notice, no matter how long it sat there — the most idle an Alpha
 *    can be (nothing dispatched, nothing running) was the one state this
 *    module structurally could not see. This is a genuinely legitimate
 *    shape too (an Alpha between slices, about to spawn its first Shadow,
 *    or one whose deliverable is an answer and correctly never spawns a
 *    child at all — `deliverable_shape: "verdict-only"`), but it is a
 *    DIFFERENT legitimacy than the one above: none of it comes from the
 *    children set, so it must be judged the same way this function already
 *    judges the Alpha itself — age floor, `reportLanded`, and last-message
 *    tags — not exempted from judgment altogether. See the call site: this
 *    is what actually answers "is the family doing anything?" instead of
 *    "are the children idle?" when there is no child to ask.
 */
function rawLiveChildrenFor(
  alphaName: string,
  evidence: IdleFamilyEvidence,
): AgentStatusesRosterEntry[] {
  return evidence.roster.filter(
    (entry) =>
      entry.lifecycle === 'live' &&
      !isStagerRole(entry.role) &&
      sameAgentName(resolvedSupervisorName(evidence.supervisors.get(entry.name)), alphaName),
  );
}

export function hasRawLiveChildren(
  alphaName: string,
  evidence: IdleFamilyEvidence,
): boolean {
  return rawLiveChildrenFor(alphaName, evidence).length > 0;
}

export function isIdleStatus(entry: AgentStatusesRosterEntry): boolean {
  return (
    entry.lifecycle === 'live' &&
    entry.liveStatus !== undefined &&
    agentStatusAcceptsInput(entry.liveStatus)
  );
}

export function isReapabilityProtocolCandidate(entry: AgentStatusesRosterEntry): boolean {
  return (
    isIdleStatus(entry) &&
    !isStagerRole(entry.role) &&
    !sameAgentName(entry.name, NO_IDLING_REGENT_NAME)
  );
}

export function cwdIsMissing(name: string, evidence: IdleFamilyEvidence): boolean {
  return evidence.cwdMissingNames?.has(name) === true;
}

/**
 * Whether `name` is a name durable ledger evidence already accounts for as
 * finished or torn down -- see `IdleFamilyEvidence.durablyAccountedForNames`.
 */
function isDurablyAccountedFor(name: string, evidence: IdleFamilyEvidence): boolean {
  return evidence.durablyAccountedForNames?.has(name) === true;
}

/**
 * Whether `entry`'s recorded supervisor is itself a live Alpha. The roster is
 * checked first (it is the only source that knows the supervisor's ROLE), but
 * a roster row that is absent or reads non-live is not trusted outright --
 * that single instantaneous snapshot is exactly what races a genuinely alive
 * supervisor (a SPAWN RACE). The durable ledger registration
 * (`IdleFamilyEvidence.registeredAgentNames`) wins over that stale/missing
 * row when present.
 *
 * An unresolved supervisor read (the reap-archival ENOENT case this module
 * exists to fix) refuses rather than degrading into either the positive or
 * the negative case: it reports `true` so the entry is excluded from
 * `findBareEntryPoints` entirely -- an unknown supervisor state must never
 * produce a false ORPHANED page, per
 * `agent_docs/MEMORY/TRISTATE_UNKNOWN_IS_NEVER_EMPTY_LAW.md`. The read
 * itself stays visible for diagnostics in `evidence.supervisors` (see that
 * field's own doc comment) without a new paging class.
 */
function hasLiveAlphaSupervisor(
  entry: AgentStatusesRosterEntry,
  evidence: IdleFamilyEvidence,
): boolean {
  const supervisorRead = evidence.supervisors.get(entry.name);
  if (supervisorReadUnresolved(supervisorRead)) {
    return true;
  }
  const supervisorName = resolvedSupervisorName(supervisorRead);
  if (supervisorName === undefined) {
    return false;
  }
  const supervisorRosterEntry = evidence.roster.find((candidate) =>
    sameAgentName(candidate.name, supervisorName),
  );
  if (supervisorRosterEntry !== undefined) {
    if (!isAlphaRole(supervisorRosterEntry.role)) {
      return false;
    }
    if (supervisorRosterEntry.lifecycle === 'live') {
      return true;
    }
  }
  return evidence.registeredAgentNames?.has(supervisorName) === true;
}

/**
 * Bare report entry points for the two shapes an Alpha-headed family can
 * never see: a custom `agent-`-prefixed agent reporting directly to the
 * Regent (no Alpha supervisor at all), and a Shadow whose supervising Alpha
 * is dead/absent from the live roster (an orphan). Both reduce to the same
 * condition — a live, non-Alpha, non-stager entry with no live Alpha
 * supervisor — and are judged with the same predicates the Alpha loop
 * already applies to a childless Alpha: age floor, idle-by-design marker,
 * and last-message tag. `reportLanded` is deliberately NOT an exclusion
 * here (unlike a family's own Alpha/child) — an orphan's supervisor is dead,
 * so there is no live supervisor left to have already reviewed it; the
 * Regent must see the entry either way and read `reportLanded` as evidence
 * ("teardown needed" vs. "read the verdict first"), never have it silently
 * excluded.
 */
function findBareEntryPoints(evidence: IdleFamilyEvidence): FullyIdleFamily[] {
  const entries: FullyIdleFamily[] = [];
  for (const entry of evidence.roster) {
    if (
      isAlphaRole(entry.role) ||
      isStagerRole(entry.role) ||
      !isIdleStatus(entry) ||
      sameAgentName(entry.name, NO_IDLING_REGENT_NAME) ||
      isDurablyAccountedFor(entry.name, evidence) ||
      hasLiveAlphaSupervisor(entry, evidence)
    ) {
      continue;
    }
    if (!cwdIsMissing(entry.name, evidence)) {
      const ageMs = evidence.agentAgeMs?.get(entry.name);
      if (ageMs !== undefined && ageMs < AGENT_MIN_AGE_MS) {
        continue;
      }
      if (evidence.idleByDesignChildren?.has(entry.name) === true) {
        continue;
      }
      const tag = evidence.lastMessageTags?.get(entry.name)?.kind;
      if (
        tag === 'blocked' ||
        tag === 'unreadable' ||
        tag === 'reapable' ||
        tag === 'reapable-failed' ||
        tag === 'busy'
      ) {
        continue;
      }
    }
    // `hasLiveAlphaSupervisor` already filtered out an unresolved read above
    // (it returns `true` -- refuse -- for that case), so this can only see a
    // Found or a field-absent read; `resolvedSupervisorName` reads `undefined`
    // for either an absent field or (defensively) an unresolved one.
    const supervisorName = resolvedSupervisorName(evidence.supervisors.get(entry.name));
    const isOrphan =
      supervisorName !== undefined && !sameAgentName(supervisorName, NO_IDLING_REGENT_NAME);
    entries.push({
      alpha: entry.name,
      idleChildren: [],
      ...(isOrphan ? { orphanedSupervisorName: supervisorName } : {}),
    });
  }
  return entries;
}

export type { BlockedMarkerLedger } from './blocked-marker-resolution.ts';
export { resolveBlockedTag } from './blocked-marker-resolution.ts';

export function findFullyIdleFamilies(
  evidence: IdleFamilyEvidence,
): FullyIdleFamily[] {
  const families: FullyIdleFamily[] = [];
  for (const alpha of evidence.roster) {
    if (
      !isAlphaRole(alpha.role) ||
      !isIdleStatus(alpha) ||
      sameAgentName(alpha.name, NO_IDLING_REGENT_NAME)
    ) {
      continue;
    }
    const alphaCwdMissing = cwdIsMissing(alpha.name, evidence);
    // A just-spawned Alpha that has not produced its first turn yet is
    // indistinguishable from a stalled one by status/pane alone. Exclude it
    // regardless of status until it clears the measured boot-time floor.
    // Unmeasurable age (map absent, or this Alpha missing from it) is NOT a
    // signal either way — it falls through to the judgment below exactly as
    // it did before this check existed. A missing `cwd` overrides this and
    // every exclusion below: it is stale by definition.
    const alphaAgeMs = evidence.agentAgeMs?.get(alpha.name);
    if (!alphaCwdMissing && alphaAgeMs !== undefined && alphaAgeMs < AGENT_MIN_AGE_MS) {
      continue;
    }
    // An Alpha that already landed its durable REPORT.md completion signal
    // (agent-statuses-registry.ts's `listCompletedAgentNames`, "the durable
    // COMPLETE signal") has finished its work and reported DONE to its
    // supervisor — it is correctly idle, awaiting a supervisor ruling, not
    // stalled mid-work. This is the ALREADY-COMPUTED discriminator on the
    // same roster entry the function already receives; nothing pane-derived
    // is needed. Checked before any `lastMessageTags` read so it excludes
    // even when the caller never populated tags. Observed live: the sweep
    // flagging a just-completed Alpha awaiting review as though it were
    // stalled (BGS-4).
    if (!alphaCwdMissing && alpha.reportLanded) {
      continue;
    }
    // Match on supervisor only, any role — mirrors discoverChildAgents in
    // reap-agent/children.ts. A role==='Shadow' filter here hid ad-hoc `Agent`
    // children (e.g. review-loop's Fable reviewer, which cannot be a Shadow
    // because Fable is outside every UnifiedRouting role pool), producing
    // false fully-idle notices against a live/working reviewer.
    //
    // Two children are excluded from consideration entirely: a just-spawned
    // child below the same age floor as an Alpha (it cannot be "stalled" on
    // work it has not had time to start reading), and a child positively
    // marked idle-by-design (a receive-only canary). A child with no marker
    // — whether or not it has assigned work — stays in this list when idle;
    // that is the genuine failure this module exists to catch.
    const children = evidence.roster.filter((entry) => {
      if (
        entry.lifecycle !== 'live' ||
        isStagerRole(entry.role) ||
        !sameAgentName(resolvedSupervisorName(evidence.supervisors.get(entry.name)), alpha.name)
      ) {
        return false;
      }
      const childAgeMs = evidence.agentAgeMs?.get(entry.name);
      if (childAgeMs !== undefined && childAgeMs < AGENT_MIN_AGE_MS) {
        return false;
      }
      if (evidence.idleByDesignChildren?.has(entry.name) === true) {
        return false;
      }
      // A child that already landed its durable REPORT.md (a terminal-gate
      // Shadow's PASS/FAIL verdict, or any other Shadow that finished and
      // reported DONE) is correctly idle, awaiting its Alpha's review/merge,
      // not stalled mid-work — the exact counterpart of the `alpha.reportLanded`
      // exclusion above, applied per-child instead of to the family head.
      // Left unexcluded, a completed Shadow counted as just another "idle
      // child" toward `allChildrenIdle`, so a family whose only child had
      // already reported PASS was flagged fully-idle and BOTH the Shadow and
      // its Alpha were poked to consider reaping/respawning a Shadow that had
      // nothing left to do (STA, 2026-08-12 — the Regent hit this live: a
      // 99b/c/d terminal-gate Shadow with a landed REPORT.md, poked anyway).
      // This module's job is "who needs poking because nothing is happening";
      // "the Alpha owes its supervisor a merge/reap of a completed child" is
      // a DIFFERENT, already-correctly-handled signal — see
      // `keep-going-stalls.ts`'s `completed-child` reason, which reads the
      // same `reportLanded` field and is not touched by this exclusion.
      if (entry.reportLanded) {
        return false;
      }
      return true;
    });
    // A vacuous `children.every(isIdleStatus)` on an empty array returns
    // `true`, which would wrongly report an Alpha as fully idle when its only
    // child is merely filtered during startup or intentionally idle. Completed
    // children are different: when every raw live child has landed its report,
    // no successor is running and the Alpha is the actionable idle member.
    const rawLiveChildren = rawLiveChildrenFor(alpha.name, evidence);
    const alphaHasRawLiveChildren = rawLiveChildren.length > 0;
    const hasUnfinishedRawLiveChild = rawLiveChildren.some(
      (entry) => !entry.reportLanded,
    );
    if (
      alphaHasRawLiveChildren &&
      !allChildrenIdle(children) &&
      hasUnfinishedRawLiveChild
    ) {
      continue;
    }
    // Every raw live child has landed its report: no successor is running
    // and the family has nothing stalled to poke about. This is NOT the
    // same as the childless case below — it is the "only child(ren) already
    // completed" case (STA, 2026-08-12 continued): the Alpha owing its
    // supervisor a merge/reap of a completed child is already the correctly-
    // handled `completed-child` reason in `keep-going-stalls.ts`, reading
    // the same `reportLanded` field, so this module stays silent here too.
    if (alphaHasRawLiveChildren && !hasUnfinishedRawLiveChild) {
      continue;
    }
    // The childless reading itself is exactly the fragile single-sample
    // signal the unifying defect names (see `confirmedNoLiveChildrenAlphaNames`'s
    // doc comment) — an unconfirmed reading is not yet trusted enough to
    // report, so the family is silently skipped this sample rather than
    // flagged on a possibly-stale snapshot. This never touches the
    // raw-live-children branch above, which is already correct.
    if (
      !alphaHasRawLiveChildren &&
      evidence.confirmedNoLiveChildrenAlphaNames !== undefined &&
      !evidence.confirmedNoLiveChildrenAlphaNames.has(alpha.name)
    ) {
      continue;
    }
    const tags = evidence.lastMessageTags;
    if (tags !== undefined) {
      const alphaTag = tags.get(alpha.name)?.kind;
      if (
        !alphaCwdMissing &&
        (alphaTag === 'blocked' ||
          alphaTag === 'unreadable' ||
          alphaTag === 'reapable' ||
          alphaTag === 'reapable-failed')
      ) {
        continue;
      }
      // Live background work excludes the family from WHICHEVER member reports
      // it, Alpha or Shadow. The common real case is a busy SHADOW: the Alpha is
      // legitimately idle awaiting its slice while the Shadow holds a running
      // test shell that herdr cannot see, so checking only the Alpha would still
      // sweep the family every minute. Observed live on shadow-sakey-99a.
      const busyMember = [alpha, ...children].find(
        (member) => tags.get(member.name)?.kind === 'busy',
      );
      if (busyMember !== undefined) {
        continue;
      }
    }
    families.push({
      alpha: alpha.name,
      idleChildren: children.map((entry) => entry.name).sort(),
    });
  }
  families.push(...findBareEntryPoints(evidence));
  return families.sort((left, right) => left.alpha.localeCompare(right.alpha));
}
