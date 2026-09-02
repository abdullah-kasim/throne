import { TREE_BASE_DATA, type TreeBase } from '../agentdata/tree-base-data.service.ts';
import { treeNameFromPath } from '../git-lifecycle/git-worktree.service.ts';
import type { Worktree } from '../git-lifecycle/git-worktree.service.ts';
import { listWorktreesInRepo } from './dependencies.ts';
import type { ReapDeps } from './reap-agent.types.ts';

export interface StrandResidue {
  treeBase: boolean;
  worktree: boolean;
}

export function hasStrandResidue(residue: StrandResidue): boolean {
  return residue.treeBase || residue.worktree;
}

export async function probeStrandResidue(
  treeName: string,
  readBase: (name: string) => Promise<TreeBase | null>,
  listRepoWorktrees: (repo?: string) => Promise<Worktree[]>,
): Promise<StrandResidue> {
  const base = await readBase(treeName);
  let worktree = false;
  try {
    const worktrees = await listRepoWorktrees(base?.repo);
    worktree = worktrees.some((candidate) => candidate.branch === treeName);
  } catch {
    worktree = false;
  }
  return { treeBase: base !== null, worktree };
}

export function strandErrorText(
  name: string,
  treeName: string,
  residue: StrandResidue,
): string {
  const leaks: string[] = [];
  if (residue.treeBase) {
    leaks.push(`  - data/${treeName}/tree-base.json is still present`);
  }
  if (residue.worktree) {
    leaks.push(`  - a worktree is still registered on branch "${treeName}"`);
  }
  return (
    `reap-agent: STRANDED TREE — reaped "${name}", but its own spawn record ` +
    `(data/${name}/spawn.json) places its worktree under a DIFFERENT name ` +
    `"${treeName}", and that tree's residue survives:\n` +
    `${leaks.join('\n')}\n` +
    `The agent's tab is already closed, so sweep the stranded tree with:\n` +
    `  ./bin/throne-cli reap-agent ${treeName} --reason orphan\n`
  );
}

export async function verifyNoStrandedTree(
  name: string,
  spawnCwd: string | undefined,
  deps: ReapDeps,
): Promise<boolean> {
  const treeName =
    spawnCwd === undefined ? undefined : treeNameFromPath(spawnCwd);
  if (treeName === undefined || treeName === name) {
    return true;
  }
  const residue = await probeStrandResidue(
    treeName,
    deps.readTreeBase ?? TREE_BASE_DATA.read.bind(TREE_BASE_DATA),
    deps.listWorktreesInRepo ?? listWorktreesInRepo,
  );
  if (!hasStrandResidue(residue)) {
    return true;
  }
  process.stderr.write(strandErrorText(name, treeName, residue));
  return false;
}
