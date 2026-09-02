import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import { errorText } from '../shared-policy/error-text.ts';
import { checkDeliveryVerdict } from '../verify-delivery/verify-delivery-runtime.ts';
import {
  deleteBranchCleanup,
  preflightBranchCleanup,
  restoreBranchCleanup,
  type BranchCleanupPlan,
} from '../git-lifecycle/branch-cleanup.ts';
import { preflightCancelledUnmergedBranch, verifyCancelledUnmergedBranch, type CancelledUnmergedBranchPlan } from '../git-lifecycle/cancelled-branch.ts';
import {
  UnmergedLifecycleBranchError,
  UnobservedMergeBranchError,
} from '../git-lifecycle/branch-authority.ts';
import {
  CANCELLED_UNMERGED_TREE_BASE_BASENAME,
  TREE_BASE_DATA,
  type CancelledUnmergedTreeBaseAuthority,
  type TreeBase,
} from '../agentdata/tree-base-data.service.ts';
import { recordAgentTiming } from '../agent-timings/record-agent-timing.ts';
import { notifyAgentCompletion } from '../notify-lord/notification.service.ts';
import {
  listUncommittedMemoryChanges,
  readSpawnCwd,
  readTreeRepo,
} from './dependencies.ts';
import {
  FORCE_DISCARD_MEMORIES_FLAG,
  FORCE_FLAG,
} from './input.ts';
import { reapAgentScratchDirs, removedScratchDirs, stillHeldScratchDirs } from './scratch-cleanup.ts';
import { terminateReapedAgentProcesses } from './process-teardown.ts';
import type {
  CancelledDisposition,
  ReapDeps,
  ReapRequest,
} from './reap-agent.types.ts';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { worktreesHome } from '../git-lifecycle/git-worktree.service.ts';
import { pathsResolveEqual } from '../shared-policy/path-equivalence.ts';


type BranchCleanupTarget =
  | {
      status: 'eligible';
      branch: string;
      repo: string;
      mergeTargetBranch: string;
      spawnCommit: string;
    }
  | { status: 'unrecorded' }
  | { status: 'legacy' };

type CleanupAuthorityDisposition = 'standard' | 'preserved';

export function isManagedEmptyWorkspace(name: string, cwd: string | undefined): boolean {
  return cwd !== undefined && pathsResolveEqual(cwd, path.join(worktreesHome(), 'empty', name));
}

export type TeardownOutcome =
  | { status: 'refused' }
  | {
      status: 'completed';
      actions: string[];
      spawnCwd: string | undefined;
      cancelledDisposition: CancelledDisposition | undefined;
    };

export function branchCleanupTarget(
  name: string,
  record: TreeBase | null,
  basename = 'tree-base.json',
): BranchCleanupTarget {
  if (record === null) {
    return { status: 'unrecorded' };
  }
  if (typeof record.name !== 'string' || record.name.length === 0) {
    throw new Error(
      `data/${name}/${basename} has no valid canonical name; refusing branch cleanup`,
    );
  }
  if (record.name !== name) {
    throw new Error(
      `data/${name}/${basename} records canonical name "${record.name}", not ` +
        `"${name}"; refusing teardown before touching either lifecycle`,
    );
  }
  for (const field of ['base', 'branch', 'commit', 'notedAt'] as const) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      throw new Error(
        `data/${name}/${basename} has invalid ${field} provenance; ` +
          'refusing branch cleanup',
      );
    }
  }
  if (record.repo === undefined) {
    return { status: 'legacy' };
  }
  if (typeof record.repo !== 'string' || record.repo.length === 0) {
    throw new Error(
      `data/${name}/${basename} has invalid target repository provenance; ` +
        'refusing branch cleanup',
    );
  }
  return {
    status: 'eligible',
    branch: record.name,
    repo: record.repo,
    mergeTargetBranch: record.branch,
    spawnCommit: record.commit,
  };
}

async function readCleanupAuthority(
  request: ReapRequest,
  deps: ReapDeps,
): Promise<{
  authority: CancelledUnmergedTreeBaseAuthority | undefined;
  disposition: CleanupAuthorityDisposition;
  target: BranchCleanupTarget;
}> {
  let authority: CancelledUnmergedTreeBaseAuthority | undefined;
  let treeBase = request.archiveCancelledUnmerged
    ? (authority = await (
        deps.readTreeBaseForCancelledUnmerged ??
        TREE_BASE_DATA.readForCancelledUnmerged.bind(TREE_BASE_DATA)
      )(request.name)).record
    : await (deps.readTreeBase ?? TREE_BASE_DATA.read.bind(TREE_BASE_DATA))(request.name);
  if (request.force && treeBase === null) {
    try {
      authority = await (
        deps.readTreeBaseForCancelledUnmerged ??
        TREE_BASE_DATA.readForCancelledUnmerged.bind(TREE_BASE_DATA)
      )(request.name);
      treeBase = authority.record;
    } catch (error) {
      if (
        !errorText(error).includes(
          'has no tree-base.json or tree-base.cancelled-unmerged.json',
        )
      ) {
        throw error;
      }
    }
  }
  const disposition =
    authority?.source === 'preserved' ? 'preserved' : 'standard';
  const target = branchCleanupTarget(
    request.name,
    treeBase,
    disposition === 'preserved'
      ? CANCELLED_UNMERGED_TREE_BASE_BASENAME
      : 'tree-base.json',
  );
  if (request.archiveCancelledUnmerged && target.status !== 'eligible') {
    throw new Error(
      `data/${request.name}/tree-base.json lacks exact target-repository provenance; ` +
        'refusing cancelled-unmerged teardown',
    );
  }
  return { authority, disposition, target };
}

async function resolveCleanupRepo(
  request: ReapRequest,
  target: BranchCleanupTarget,
  disposition: CleanupAuthorityDisposition,
  deps: ReapDeps,
): Promise<string | undefined> {
  const strictRecordedRepo =
    request.archiveCancelledUnmerged || disposition === 'preserved'
      ? undefined
      : await (deps.readTreeRepo ?? readTreeRepo)(request.name);
  if (
    target.status === 'eligible' &&
    strictRecordedRepo !== undefined &&
    strictRecordedRepo !== target.repo
  ) {
    throw new Error(
      `data/${request.name}/tree-base.json changed while branch authority was being read; ` +
        'refusing teardown',
    );
  }
  return target.status === 'eligible' ? target.repo : strictRecordedRepo;
}

async function refuseUncommittedMemories(
  request: ReapRequest,
  repo: string | undefined,
  deps: ReapDeps,
): Promise<boolean> {
  const memoryChanges = await (
    deps.listUncommittedMemoryChanges ?? listUncommittedMemoryChanges
  )(request.name, repo);
  if (memoryChanges.length === 0 || request.forceDiscardMemories) {
    return false;
  }
  const message =
    `reap-agent: refusing to reap "${request.name}" because its worktree contains ` +
    `uncommitted agent memories:\n` +
    `${memoryChanges.map((change) => `  ${change}`).join('\n')}\n` +
    `Commit these files to the slice branch before reaping so they can be ` +
    `merged back, or explicitly discard them by re-running with ` +
    `${FORCE_DISCARD_MEMORIES_FLAG}. ${FORCE_FLAG} alone never permits ` +
    `discarding memories.\n`;
  (deps.writeMemoryRefusal ?? ((text: string) => process.stderr.write(text)))(
    message,
  );
  return true;
}

async function preflightBranchDisposition(
  request: ReapRequest,
  target: BranchCleanupTarget,
  authority: CancelledUnmergedTreeBaseAuthority | undefined,
  disposition: CleanupAuthorityDisposition,
  deps: ReapDeps,
  contentDeliveryCommit?: string,
  allowUnadvancedBranch = false,
): Promise<{
  ordinary: BranchCleanupPlan | undefined;
  cancelled: CancelledUnmergedBranchPlan | undefined;
  authority: CancelledUnmergedTreeBaseAuthority | undefined;
}> {
  if (
    (request.archiveCancelledUnmerged ||
      (request.force && disposition === 'preserved')) &&
    target.status === 'eligible'
  ) {
    return {
      ordinary: undefined,
      cancelled: await (
        deps.preflightCancelledUnmergedBranch ??
        preflightCancelledUnmergedBranch
      )(target.branch, target.repo, target.mergeTargetBranch),
      authority,
    };
  }
  if (target.status === 'eligible') {
    try {
      return {
        ordinary: await (
          deps.preflightBranchCleanup ?? preflightBranchCleanup
        )(
          target.branch,
          target.repo,
          target.mergeTargetBranch,
          request.force,
          target.spawnCommit,
          contentDeliveryCommit,
          allowUnadvancedBranch,
        ),
        cancelled: undefined,
        authority: undefined,
      };
    } catch (error) {
      if (!request.force || !(error instanceof UnmergedLifecycleBranchError)) {
        throw error;
      }
      if (error instanceof UnobservedMergeBranchError) {
        process.stderr.write(
          `reap-agent: branch "${target.branch}" never advanced past its ` +
            `recorded spawn commit; preserving it untouched instead of ` +
            `reaping. Worktree/archive teardown continues, but investigate ` +
            `that branch before reusing this name.\n`,
        );
        return { ordinary: undefined, cancelled: undefined, authority: undefined };
      }
      const authority = await (
        deps.readTreeBaseForCancelledUnmerged ??
        TREE_BASE_DATA.readForCancelledUnmerged.bind(TREE_BASE_DATA)
      )(request.name);
      branchCleanupTarget(request.name, authority.record);
      return {
        ordinary: undefined,
        cancelled: await (
          deps.preflightCancelledUnmergedBranch ??
          preflightCancelledUnmergedBranch
        )(target.branch, target.repo, target.mergeTargetBranch),
        authority,
      };
    }
  }
  if (target.status === 'legacy') {
    process.stderr.write(
      `reap-agent: data/${request.name}/tree-base.json predates target-repository ` +
        `provenance; preserving any branch named "${request.name}". Worktree/archive ` +
        `teardown continues, but inspect that branch before reusing this name.\n`,
    );
  }
  return { ordinary: undefined, cancelled: undefined, authority: undefined };
}

async function deleteOrdinaryBranch(
  plan: BranchCleanupPlan | undefined,
  removedWorktree: boolean,
  deps: ReapDeps,
  actions: string[],
): Promise<void> {
  if (plan?.status !== 'ready') {
    return;
  }
  try {
    if (await (deps.deleteBranchCleanup ?? deleteBranchCleanup)(plan)) {
      actions.push(`deleted delivered branch ${plan.branch}`);
    }
  } catch (deleteError) {
    let recovery = 'branch tip and live ledger retained';
    if (removedWorktree) {
      try {
        await (deps.restoreBranchCleanup ?? restoreBranchCleanup)(plan);
        recovery += '; restored a clean worktree for retry';
      } catch (restoreError) {
        recovery +=
          `; clean worktree restoration failed (${errorText(restoreError)}), ` +
          'but the ledger remains unarchived for manual recovery';
      }
    }
    throw new Error(
      `required branch cleanup for "${plan.branch}" failed ` +
        `(${errorText(deleteError)}); ${recovery}`,
    );
  }
}

async function preserveCancelledBranch(
  name: string,
  plan: CancelledUnmergedBranchPlan | undefined,
  authority: CancelledUnmergedTreeBaseAuthority | undefined,
  deps: ReapDeps,
  actions: string[],
): Promise<void> {
  if (plan === undefined || authority === undefined) {
    return;
  }
  await (
    deps.preserveTreeBaseForCancelledUnmerged ??
    TREE_BASE_DATA.preserveForCancelledUnmerged.bind(TREE_BASE_DATA)
  )(name, authority);
  actions.push(
    `preserved provenance as ${CANCELLED_UNMERGED_TREE_BASE_BASENAME}`,
  );
  await (
    deps.verifyCancelledUnmergedBranch ?? verifyCancelledUnmergedBranch
  )(plan);
}

async function cleanupReapedAgentScratch(
  request: ReapRequest,
  deps: ReapDeps,
  actions: string[],
): Promise<void> {
  try {
    const results = await (deps.cleanupAgentScratch ?? reapAgentScratchDirs)(
      request.name,
    );
    const removed = removedScratchDirs(results);
    if (removed.length > 0) {
      actions.push(`removed scratch: ${removed.join(', ')}`);
    }
    const stillHeld = stillHeldScratchDirs(results);
    if (stillHeld.length > 0) {
      process.stderr.write(
        `reap-agent: scratch still held by a live process, left in place: ` +
          `${stillHeld.join(', ')}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `reap-agent: scratch cleanup failed for "${request.name}" ` +
        `(${errorText(error)}) — continuing teardown.\n`,
    );
  }
}

async function recordLifecycleEffects(
  request: ReapRequest,
  deps: ReapDeps,
): Promise<void> {
  try {
    await (deps.recordTiming ?? recordAgentTiming)(request.name, request.reason);
  } catch (error) {
    process.stderr.write(
      `reap-agent: could not record timing for "${request.name}" (${errorText(error)}) ` +
        `— continuing teardown.\n`,
    );
  }
  try {
    await (deps.notify ?? notifyAgentCompletion)(
      request.name,
      request.reason,
    );
  } catch (error) {
    process.stderr.write(
      `reap-agent: could not send completion notification for "${request.name}" ` +
        `(${errorText(error)}) — continuing teardown.\n`,
    );
  }
}

export async function executeTeardown(
  request: ReapRequest,
  live: HerdrAgent | undefined,
  deps: ReapDeps,
  allowUnadvancedBranch = false,
): Promise<TeardownOutcome> {
  const actions: string[] = [];
  const { authority, disposition, target } = await readCleanupAuthority(
    request,
    deps,
  );
  const repo = await resolveCleanupRepo(request, target, disposition, deps);
  if (await refuseUncommittedMemories(request, repo, deps)) {
    return { status: 'refused' };
  }
  const spawnCwd = await (deps.readSpawnCwd ?? readSpawnCwd)(request.name);
  const deliveryVerdict = await (
    deps.checkDeliveryVerdict ?? checkDeliveryVerdict
  )(request.name, undefined);
  const plans = await preflightBranchDisposition(
    request,
    target,
    authority,
    disposition,
    deps,
    deliveryVerdict.status === 'delivered'
      ? deliveryVerdict.contentDeliveryCommit
      : undefined,
    allowUnadvancedBranch,
  );

  if (live !== undefined) {
    await deps.closeAgentTab(live);
    actions.push(
      live.tabId ? `closed tab ${live.tabId}` : `closed pane ${live.paneId}`,
    );
  }
  await terminateReapedAgentProcesses(request, deps, actions);
  const removedWorktree = await deps.removeTree(request.name, repo);
  if (removedWorktree) {
    actions.push('removed worktree');
  } else if (isManagedEmptyWorkspace(request.name, spawnCwd)) {
    await rm(spawnCwd!, { recursive: true, force: false });
    actions.push('removed managed empty workspace');
  }
  await preserveCancelledBranch(
    request.name,
    plans.cancelled,
    plans.authority ?? authority,
    deps,
    actions,
  );
  await deleteOrdinaryBranch(
    plans.ordinary,
    removedWorktree,
    deps,
    actions,
  );
  await recordLifecycleEffects(request, deps);

  const archiveResult = await deps.archiveAgentData(request.name);
  if (plans.cancelled !== undefined && archiveResult !== 'archived') {
    throw new Error(
      `data/${request.name} vanished before cancelled-unmerged archival completed`,
    );
  }
  if (archiveResult === 'archived') {
    actions.push(
      plans.cancelled !== undefined
        ? `archived complete ledger under data/.reaped/ with ${CANCELLED_UNMERGED_TREE_BASE_BASENAME}`
        : `archived data/${request.name} → data/.reaped/${request.name}`,
    );
  }
  await cleanupReapedAgentScratch(request, deps, actions);
  return {
    status: 'completed',
    actions,
    spawnCwd,
    cancelledDisposition: plans.cancelled,
  };
}
