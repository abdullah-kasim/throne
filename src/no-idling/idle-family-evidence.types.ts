// Types only -- the per-sweep evidence contract `idle-family.ts`'s detection
// functions read, split into its own companion module because its doc
// comments (the field-by-field rationale for every optional evidence signal)
// are substantial enough to obscure the detection logic when inline.
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import type { IdentityLineRead } from '../agentdata/identity-data.service.ts';
import type { LastMessageTagState } from './idle-pane-tag-classification.ts';

export interface FullyIdleFamily {
  readonly alpha: string;
  readonly idleChildren: readonly string[];
  // Set only for a `findBareEntryPoints` entry whose recorded supervisor is
  // someone OTHER than the Regent yet is not a live Alpha -- i.e. its
  // intended supervisor once existed and is now gone (dead/reaped/absent
  // from the live roster), as opposed to a custom `agent-`-prefixed entry
  // that reports directly to the Regent BY DESIGN and was never supervised
  // by an Alpha at all. Absent (never present, not merely undefined) for
  // every family-loop Alpha entry and every by-design bare entry, so every
  // pre-existing `deepEqual({alpha, idleChildren})` assertion is unaffected.
  // See `message.ts`'s orphan-specific remediation section, which is the
  // consumer this field exists for.
  readonly orphanedSupervisorName?: string;
}

export interface IdleFamilyEvidence {
  readonly roster: readonly AgentStatusesRosterEntry[];
  // The tristate supervisor read per roster entry, not collapsed to a
  // string -- an unresolved read (any errno, corrupt/partial content) must
  // stay distinguishable from a genuinely absent supervisor field, per
  // `agent_docs/MEMORY/TRISTATE_UNKNOWN_IS_NEVER_EMPTY_LAW.md`. See
  // `resolvedSupervisorName`/`hasLiveAlphaSupervisor` for how each state is
  // read.
  readonly supervisors: ReadonlyMap<string, IdentityLineRead>;
  readonly lastMessageTags?: ReadonlyMap<string, LastMessageTagState>;
  // Keyed by agent name, ANY role — an Alpha's just-spawned child is exactly
  // as indistinguishable-from-stalled as a just-spawned Alpha, and children
  // outnumber Alphas, so this is the more frequent path. See AGENT_MIN_AGE_MS.
  readonly agentAgeMs?: ReadonlyMap<string, number>;
  // Names of CHILDREN positively marked idle-by-design — a receive-only
  // canary carrying its own ledger marker file recording that it was never
  // meant to be given work. A child in this set is excluded from
  // idle-family consideration entirely — never counted toward the family's
  // idle gate, never listed — regardless of whether it holds an
  // ASSIGNMENT.md or todo bundle. Absence from this set NEVER excludes a
  // child: a child with no marker and no assigned work (e.g. tasked by
  // direct send-agent, no ASSIGNMENT.md) still reports when idle, because a
  // silently-stalled directly-tasked Shadow is exactly the alarm this
  // module exists to raise (shadow-tbk-09, 2026-08-11 — an ASSIGNMENT.md
  // that was never delivered, so the Shadow sat at its bare identity prompt
  // indefinitely; nothing else in the court could see it). Undefined
  // disables this filter entirely (pre-existing behavior); an Alpha is
  // never subject to it — an Alpha always owns its own todo bundle by
  // construction.
  //
  // Design principle: this is a deliberate trade of silence for noise, not
  // an accepted regression. The prior absence-based rule failed silently —
  // a missing ASSIGNMENT.md hid a genuinely stalled Shadow forever, with
  // nothing left in the court to ever raise the alarm. This positive-marker
  // rule fails loudly instead — a genuine canary that was never given its
  // marker shows up as one false-positive idle report, dismissible in a
  // single measurement by whoever reads the notice. A missed alarm is
  // dangerous; one extra noisy notice is not, so the rule is built to err
  // toward noise.
  readonly idleByDesignChildren?: ReadonlySet<string>;
  // Names of live-roster entries whose recorded `cwd` no longer exists on
  // disk (checked at the evidence-assembly layer in `no-idling-run.ts`).
  // Membership here overrides every other exclusion signal for that entry's
  // OWN entry-point evaluation (age floor, idle-by-design marker,
  // `reportLanded`, last-message tag) — a deleted working directory is stale
  // by definition, regardless of what else the entry otherwise looks like.
  readonly cwdMissingNames?: ReadonlySet<string>;
  // Alpha names whose "this Alpha currently has zero raw live children"
  // reading has been confirmed across ≥2 consecutive sweep samples with no
  // intervening ledger motion, via the shared
  // `ConfirmedObservationTracker`/`decideConfirmation` contract
  // (`confirmed-observation.ts`). A single roster snapshot can transiently
  // fail to reflect a genuinely live child (the unifying defect behind FP2:
  // alpha-lnb-lane-budget/alpha-nid-no-indeterminate were flagged "fully
  // idle" while a live Shadow was working, because that one sample's
  // roster/supervisor evidence read as childless) — this set is the caller's
  // (`no-idling-run.ts`) confirmation that the childless reading held twice
  // in a row before it is trusted enough to report. Undefined disables
  // confirmation entirely, preserving prior single-sample behavior — this is
  // what every existing unit test exercises, since only the real sweep
  // caller wires the tracker. This ONLY governs the already-childless
  // reading; an Alpha with raw live children who all filter out is still
  // decided by `hasRawLiveChildren`/`allChildrenIdle` below, unaffected by
  // this set.
  readonly confirmedNoLiveChildrenAlphaNames?: ReadonlySet<string>;
  // Names durable ledger evidence already accounts for as finished or torn
  // down -- a landed `REPORT.md`, a `delivery-evidence.json` landing record,
  // or `.reaped/` archival (`ledger-data.service.ts`'s `isDurablyAccountedFor`).
  // `findBareEntryPoints` must never emit an orphan/untasked entry for a name
  // in this set, regardless of what its roster row or supervisor look like --
  // a REAP RACE between the roster snapshot and this evidence landing is
  // exactly what this set exists to close. Undefined disables the check
  // entirely, preserving prior behavior for every caller that has not wired
  // ledger evidence through.
  readonly durablyAccountedForNames?: ReadonlySet<string>;
  // Names carrying a live top-level ledger registration (`identity.md` or
  // `spawn.json` present, not yet archived to `.reaped/`) -- the same durable
  // identity evidence the rest of the court trusts. `hasLiveAlphaSupervisor`
  // falls back to this set when a recorded supervisor's roster row is absent
  // or reads non-live, since a single roster snapshot can race a genuinely
  // alive supervisor (a SPAWN RACE). Undefined disables the fallback,
  // preserving prior roster-only behavior.
  readonly registeredAgentNames?: ReadonlySet<string>;
}
