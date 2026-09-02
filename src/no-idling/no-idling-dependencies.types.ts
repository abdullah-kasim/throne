// The `NoIdlingDependencies` type on its own, with no imports back into
// no-idling-run.ts or no-idling-notify-guard.ts -- both of those import it
// from here, which is what keeps that pair acyclic
// (test/campaign-evidence/source-file-structure.spec.ts's dependency-graph
// check forbids cycles even where TS's `import type` erasure would make one
// runtime-harmless).
import type { HerdrAgent, ReadOptions } from '../herdr/herdr-inventory.service.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import type { IdentityLineRead } from '../agentdata/identity-data.service.ts';
import type { BlockedMarkerLedger } from './idle-family.ts';
import type { SubmitToAgentOptions } from '../herdr/herdr-send.types.ts';
import type { SpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import type { StaleTabReport, StrandedSpawnReport } from './stale-tab-report.ts';
import type { ConfirmedObservationTracker } from './confirmed-observation.ts';
import type {
  StrandedSpawnClassification,
} from './stranded-spawn-classification.ts';
import type { StrandedSpawnRecoveryResult } from './stranded-spawn-recovery.ts';

export interface NoIdlingDependencies {
  resolveLiveRoot: () => Promise<string>;
  getRoster: (dataDir: string) => Promise<AgentStatusesRosterEntry[]>;
  readAgentSupervisor: (name: string, dataDir: string) => Promise<IdentityLineRead>;
  resolveAgent: (name: string) => Promise<HerdrAgent>;
  submitToAgent: (
    target: HerdrAgent,
    sender: string,
    prompt: string,
    options?: SubmitToAgentOptions,
  ) => Promise<void>;
  readAgent: (name: string, opts?: ReadOptions) => Promise<string>;
  blockedMarkerLedger: BlockedMarkerLedger;
  readSpawnSpec: (name: string, dataDir: string) => Promise<SpawnSpec | null>;
  hasFutureScheduledDelivery?: (name: string, nowMs: number) => Promise<boolean>;
  // Whether the named agent's ledger directory carries the positive
  // idle-by-design marker file — the discriminator between a genuine
  // receive-only canary and any other child, tasked or not. Absence never
  // excludes a child; only the marker's presence does.
  isIdleByDesign: (name: string, dataDir: string) => Promise<boolean>;
  // Allowlist-only join of `herdr tab list` output against the throne ledger
  // (`findStaleThroneTabs`/`detectStaleThroneTabs`) — read-only, never calls
  // tab-close. Returns the empty array when nothing is positively identified
  // as a throne-owned stale tab.
  detectStaleTabs: (dataDir: string) => Promise<StaleTabReport[]>;
  // Positively-identified live spawns stuck behind a modal or an
  // absent/unsubmitted opening prompt (`detectStrandedSpawns`) —
  // `findStaleThroneTabs`'s allowlist candidates that pane-content
  // classification pulled OUT of `detectStaleTabs`'s result, so the two
  // are always disjoint. Read-only; never recovers or closes anything.
  detectStrandedSpawns: (dataDir: string) => Promise<StrandedSpawnReport[]>;
  // Mechanically clears one stranded-spawn classification (modal keypress
  // and/or opening-prompt redelivery, per `recoverStrandedSpawn`'s
  // classification-to-remedy dispatch) and reports the outcome for logging.
  // Never throws; a failed remedy resolves to an outcome, not a rejection.
  recoverStrandedSpawn: (
    agentName: string,
    classification: StrandedSpawnClassification,
    dataDir: string,
  ) => Promise<StrandedSpawnRecoveryResult>;
  // Whether a roster entry's recorded `cwd` still exists on disk — the
  // filesystem half of the cwd-staleness evidence threaded into
  // `IdleFamilyEvidence.cwdMissingNames`. A deleted working directory
  // overrides every other staleness exclusion.
  checkCwdExists: (cwd: string) => Promise<boolean>;
  // Whether durable ledger evidence already accounts for the named agent as
  // finished or torn down -- a landed REPORT.md, a delivery-evidence.json
  // record, or `.reaped/` archival (`isDurablyAccountedFor`). The evidence
  // half of `IdleFamilyEvidence.durablyAccountedForNames`.
  isDurablyAccountedFor: (name: string, dataDir: string) => Promise<boolean>;
  // Whether the named agent carries a live top-level ledger registration,
  // not yet archived to `.reaped/` (`agentRegistrationExists`). The evidence
  // half of `IdleFamilyEvidence.registeredAgentNames`, used to confirm a
  // recorded supervisor is genuinely alive even when this sweep's roster
  // snapshot raced past it.
  isRegisteredAgent: (name: string, dataDir: string) => Promise<boolean>;
  // Whether the named Alpha has both a durable delivery-evidence.json record
  // and a commit from that record actually landed on its recorded target
  // branch (`hasProvenDelivery`). The completed-Alpha lifecycle notice's
  // evidence half: a `reapable` last-message tag alone never proves this --
  // an Alpha idle-awaiting a live Shadow ends its own turn `reapable` too.
  hasProvenDelivery: (name: string, dataDir: string) => Promise<boolean>;
  now?: () => number;
  /**
   * Carries each Alpha's "no raw live children" confirmation streak across
   * sweeps (FP2's fix — see `idle-family.ts`'s
   * `confirmedNoLiveChildrenAlphaNames` doc comment for the full defect).
   * Absent means a fresh tracker is created for this single call, which
   * confirms every reading immediately — the behavior every test in this
   * module already assumes. Production wiring (`REAL_NO_IDLING_DEPENDENCIES`)
   * supplies one long-lived instance shared across the hosted worker's
   * repeated ticks, which is what actually confirms across real,
   * consecutive minute-apart samples.
   */
  fullyIdleFamilyLiveChildrenTracker?: ConfirmedObservationTracker;
  /** Process-lifetime set of unchanged exclusion diagnostics already emitted. */
  excludedFamilyObservations?: Set<string>;
  /**
   * Optional output sinks, defaulting to `process.stdout.write`/
   * `process.stderr.write` when absent -- mirrors `KeepGoingDependencies`'
   * same fields (`src/keep-going/keep-going-sweep.ts`) so the REST route
   * handler can capture a manual trigger's output without touching
   * `throne-backend`'s own process streams.
   */
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}
