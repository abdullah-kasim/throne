import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { closeAgentTab } from '../herdr/herdr-tab.service.ts';
import { listAgents, readAgent } from '../herdr/herdr-runtime.service.ts';
import {
  deleteBranchCleanup,
  preflightBranchCleanup,
  restoreBranchCleanup,
} from '../git-lifecycle/branch-cleanup.ts';
import { preflightCancelledUnmergedBranch, verifyCancelledUnmergedBranch } from '../git-lifecycle/cancelled-branch.ts';
import { THRONE_PROJECT_DIR } from '../git-lifecycle/git-worktree.service.ts';
import { GitWorktreeService, type Worktree } from '../git-lifecycle/git-worktree.service.ts';
import { repoRoot } from '../git-lifecycle/git-command.service.ts';
import { readAgentSupervisor, readAgentRole } from '../agentdata/identity-data.service.ts';
import { readSpawnSpec, DEFAULT_DATA_DIR } from '../agentdata/spawn-data-contracts.ts';
import { TREE_BASE_DATA } from '../agentdata/tree-base-data.service.ts';
import { LedgerDataService } from '../agentdata/ledger-data.service.ts';
import { DELIVERY_EVIDENCE_DATA } from '../agentdata/delivery-evidence-data.service.ts';
import { isAncestor } from '../git-lifecycle/delivery.ts';
import { recordAgentTiming } from '../agent-timings/record-agent-timing.ts';
import { notifyAgentCompletion } from '../notify-lord/notification.service.ts';
import {
  hasDeliveryCommit,
  resolveDeliveryRepoRoot,
} from '../git-lifecycle/delivery-commit-proof.ts';
import { checkAgentEvidenceRequirementByName } from '../slice-evidence/agent-evidence-gate.ts';
import { writeQueueReapOutcome } from './queue-reap-writeback.ts';
import { MEMORY_PATH } from './input.ts';
import { reapAgentScratchDirs } from './scratch-cleanup.ts';
import { terminateWorktreeProcesses } from './process-teardown.ts';
import type { ReapDeps } from './reap-agent.types.ts';

const WORKTREES = new GitWorktreeService();
const LEDGER_DATA = new LedgerDataService();

export const readTreeRepo = async (
  name: string,
): Promise<string | undefined> =>
  (await TREE_BASE_DATA.readForBranchCleanup(name))?.repo ?? undefined;

export const readSpawnCwd = async (
  name: string,
): Promise<string | undefined> => (await readSpawnSpec(name))?.cwd ?? undefined;

export const listWorktreesInRepo = async (
  repo?: string,
): Promise<Worktree[]> => WORKTREES.list(await repoRoot(repo ?? process.cwd()));

async function memoryGuardPathspecs(
  root: string,
  projectDir: string,
): Promise<string[]> {
  const [realRoot, realProject] = await Promise.all([
    realpath(root),
    realpath(projectDir),
  ]);
  const subpath = path.relative(realRoot, realProject);
  return subpath === ''
    ? [MEMORY_PATH]
    : [MEMORY_PATH, path.join(subpath, MEMORY_PATH)];
}

export async function listUncommittedMemoryChanges(
  name: string,
  repo?: string,
): Promise<string[]> {
  const projectDir = repo ?? THRONE_PROJECT_DIR;
  const root = await repoRoot(projectDir);
  const tree = (await WORKTREES.list(root)).find(
    (worktree) => worktree.branch === name,
  );
  if (tree === undefined) {
    return [];
  }
  const pathspecs = await memoryGuardPathspecs(root, projectDir);
  const porcelain = await new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      [
        '-C',
        tree.path,
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--',
        ...pathspecs,
      ],
      { encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `git status failed for ${tree.path}: ${stderr.trim() || err.message}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
  return porcelain.split('\n').filter((line) => line.length > 0);
}

export async function readCompletionReport(
  name: string,
): Promise<string | undefined> {
  try {
    return await readFile(
      path.join(DEFAULT_DATA_DIR, name, 'REPORT.md'),
      'utf8',
    );
  } catch {
    return undefined;
  }
}

export const REAL_DEPS: ReapDeps = {
  listAgents,
  readAgent,
  readSpawnSpec,
  closeAgentTab,
  removeTree: WORKTREES.remove.bind(WORKTREES),
  archiveAgentData: LEDGER_DATA.archiveAgentData,
  preflightBranchCleanup,
  readTreeBaseForCancelledUnmerged: TREE_BASE_DATA.readForCancelledUnmerged.bind(TREE_BASE_DATA),
  preserveTreeBaseForCancelledUnmerged: TREE_BASE_DATA.preserveForCancelledUnmerged.bind(TREE_BASE_DATA),
  preflightCancelledUnmergedBranch,
  verifyCancelledUnmergedBranch,
  deleteBranchCleanup,
  restoreBranchCleanup,
  listCompletedAgents: LEDGER_DATA.listCompletedAgents,
  hasCompletionReport: LEDGER_DATA.hasCompletionReport,
  readCompletionReport,
  readAgentRole,
  readDeliveryEvidence: (name) => DELIVERY_EVIDENCE_DATA.read(name),
  isAncestor,
  listRegisteredAgents: LEDGER_DATA.listRegisteredAgents,
  hasDeliveryCommit: async (name) =>
    hasDeliveryCommit(name, await resolveDeliveryRepoRoot(name)),
  checkEvidenceRequirement: checkAgentEvidenceRequirementByName,
  readAgentSupervisor,
  recordTiming: (name, reason) => recordAgentTiming(name, reason),
  notify: notifyAgentCompletion,
  readTreeRepo,
  readSpawnCwd,
  readTreeBase: TREE_BASE_DATA.read.bind(TREE_BASE_DATA),
  listWorktreesInRepo,
  listUncommittedMemoryChanges,
  cleanupAgentScratch: (name) => reapAgentScratchDirs(name),
  terminateWorktreeProcesses: (worktreePath) => terminateWorktreeProcesses(worktreePath),
  writeQueueReapOutcome,
};
