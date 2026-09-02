import type { closeAgentTab } from '../herdr/herdr-tab.service.ts';
import type { listAgents } from '../herdr/herdr-runtime.service.ts';
import type { readAgent } from '../herdr/herdr-runtime.service.ts';
import type {
  BranchCleanupPlan,
  deleteBranchCleanup,
  preflightBranchCleanup,
  restoreBranchCleanup,
} from '../git-lifecycle/branch-cleanup.ts';
import type {
  CancelledUnmergedBranchPlan,
  preflightCancelledUnmergedBranch,
  verifyCancelledUnmergedBranch,
} from '../git-lifecycle/cancelled-branch.ts';
import type { Worktree } from '../git-lifecycle/git-worktree.service.ts';
import type {
  TreeBase,
  CancelledUnmergedTreeBaseAuthority,
} from '../agentdata/tree-base-data.service.ts';
import type { readAgentSupervisor, readAgentRole } from '../agentdata/identity-data.service.ts';
import type { LedgerDataService } from '../agentdata/ledger-data.service.ts';
import type { DeliveryEvidenceRecord } from '../agentdata/delivery-evidence-record.ts';
import type { isAncestor } from '../git-lifecycle/delivery.ts';
import type { ReapReason } from '../agent-timings/reap-reason.ts';
import type { ScratchDirRemovalResult } from '../tmp-scratch-lifecycle/tmp-scratch-lifecycle.types.ts';
import type { SliceEvidenceResult } from '../slice-evidence/agent-evidence-gate.ts';
import type { writeQueueReapOutcome } from './queue-reap-writeback.ts';
import type { appendLaunchLedgerStatus } from '../alpha-launch-queue/launch-ledger.ts';
import type { checkDeliveryVerdict } from '../verify-delivery/verify-delivery-runtime.ts';
import type { readSpawnSpec } from '../agentdata/spawn-data-contracts.ts';

/** What one worktree process-teardown pass actually did. Lives here rather
 *  than in `process-teardown.ts` so `ReapDeps` can name it without the two
 *  files importing each other — `process-teardown.ts` already imports
 *  `ReapDeps` from here, and the reverse edge would close a cycle the
 *  source-structure spec refuses. */
export interface WorktreeProcessTeardownResult {
  killed: { pid: number; cmdline: string; outcome: string }[];
  failed: { pid: number; cmdline: string }[];
}

export interface ReapDeps {
  listAgents: typeof listAgents;
  readAgent?: typeof readAgent;
  readSpawnSpec?: typeof readSpawnSpec;
  /** Overrides the delay between confirmation resamples of `listAgents()`
   *  (`lifecycle.ts`'s `confirmedAgents`). Only ever needed by tests — real
   *  callers get the production interval by omitting it. */
  sleep?: (milliseconds: number) => Promise<void>;
  closeAgentTab: typeof closeAgentTab;
  removeTree: (name: string, projectDir?: string) => Promise<boolean>;
  archiveAgentData: LedgerDataService['archiveAgentData'];
  preflightBranchCleanup?: typeof preflightBranchCleanup;
  readTreeBaseForCancelledUnmerged?: (name: string) => Promise<CancelledUnmergedTreeBaseAuthority>;
  preserveTreeBaseForCancelledUnmerged?: (name: string, authority: CancelledUnmergedTreeBaseAuthority) => Promise<'preserved' | 'already-preserved'>;
  preflightCancelledUnmergedBranch?: typeof preflightCancelledUnmergedBranch;
  verifyCancelledUnmergedBranch?: typeof verifyCancelledUnmergedBranch;
  deleteBranchCleanup?: typeof deleteBranchCleanup;
  restoreBranchCleanup?: typeof restoreBranchCleanup;
  listCompletedAgents: LedgerDataService['listCompletedAgents'];
  /** Whether `name`'s own ledger directory carries a landed `REPORT.md` —
   *  the per-agent form of `listCompletedAgents`, used by the Alpha
   *  auto-reapability legs to avoid scanning every registered agent for one. */
  hasCompletionReport?: LedgerDataService['hasCompletionReport'];
  /** Raw `REPORT.md` text for `name`, or `undefined` when none is on file —
   *  read to detect an explicit no-delivery completion outcome. */
  readCompletionReport?: (name: string) => Promise<string | undefined>;
  /** `name`'s role as its own `identity.md` durably records it
   *  (`readAgentRole`'s `IdentityLineRead` result) — the Alpha-only gate for
   *  the two automatic reapability-claim legs. */
  readAgentRole?: typeof readAgentRole;
  /** `name`'s landed `delivery-evidence.json` record, or `null` when absent. */
  readDeliveryEvidence?: (name: string) => Promise<DeliveryEvidenceRecord | null>;
  /** Whether `ancestor` is a git ancestor of `descendant` inside the repo at
   *  `root` — reused from `git-lifecycle/delivery.ts`'s own ancestor check. */
  isAncestor?: typeof isAncestor;
  /** A second, independent completion signal alongside REPORT.md: true when a
   *  `Deliver <name>` commit (stamped by `mergeBack`, see
   *  `git-lifecycle/merge.ts`) is reachable in the throne's own branch
   *  history. A Shadow reports DONE via send-agent and never writes
   *  REPORT.md, so this is its only durable completion proof. */
  hasDeliveryCommit?: (name: string) => Promise<boolean>;
  /** A stated-evidence gate: `ok: true` when the agent's own ASSIGNMENT.md
   *  states no `Evidence required:` line, or its REPORT.md satisfies the one
   *  it does state. Falls back to allowing reap when omitted. Applied only
   *  for `--reason completed`, the case where a completion claim can carry
   *  an unmet evidence requirement. */
  checkEvidenceRequirement?: (name: string) => Promise<SliceEvidenceResult>;
  listRegisteredAgents: LedgerDataService['listRegisteredAgents'];
  readAgentSupervisor: typeof readAgentSupervisor;
  recordTiming?: (name: string, reason: ReapReason) => Promise<void>;
  notify?: (name: string, reason: ReapReason) => Promise<unknown>;
  readTreeRepo?: (name: string) => Promise<string | undefined>;
  readSpawnCwd?: (name: string) => Promise<string | undefined>;
  readTreeBase?: (name: string) => Promise<TreeBase | null>;
  listWorktreesInRepo?: (repo?: string) => Promise<Worktree[]>;
  listUncommittedMemoryChanges?: (
    name: string,
    repo?: string,
  ) => Promise<string[]>;
  writeMemoryRefusal?: (message: string) => void;
  cleanupAgentScratch?: (name: string) => Promise<ScratchDirRemovalResult[]>;
  /** Terminates processes still working inside the reaped agent's worktree,
   *  identified by cwd containment (never by pid guessing or name matching).
   *  Injected as an effect so no test ever signals a real process. Falls
   *  back to the real `/proc`-and-`process.kill` implementation when
   *  omitted; a test that wants no kills at all supplies a no-op. */
  terminateWorktreeProcesses?: (
    worktreePath: string,
  ) => Promise<WorktreeProcessTeardownResult>;
  /** Transitions the Regent queue item this reap's agent name is recorded
   *  against (see `create-agent`'s launch write-back) per the reap reason's
   *  status mapping — `regent-queue-lifecycle.ts`'s `reap-agent` side.
   *  Falls back to no write-back when omitted. */
  writeQueueReapOutcome?: typeof writeQueueReapOutcome;
  /** Appends the launch-ledger terminal-status line for a reaped agent.
   *  Falls back to the real implementation when omitted. */
  appendLaunchLedgerStatus?: typeof appendLaunchLedgerStatus;
  checkDeliveryVerdict?: typeof checkDeliveryVerdict;
  launchLedgerPath?: string;
  now?: () => string;
}

export interface ParsedReapArgs {
  name?: string;
  force: boolean;
  bypassMarker: boolean;
  forceDiscardMemories: boolean;
  archiveCancelledUnmerged: boolean;
  reason?: ReapReason;
}

export interface ReapRequest {
  name: string;
  force: boolean;
  bypassMarker?: boolean;
  forceDiscardMemories: boolean;
  archiveCancelledUnmerged: boolean;
  reason: ReapReason;
}

export type CancelledDisposition = Pick<
  CancelledUnmergedBranchPlan,
  'ref' | 'tip'
>;

export type ReadyBranchCleanupPlan = Extract<
  BranchCleanupPlan,
  { status: 'ready' }
>;
