import { repoRoot } from "../git-lifecycle/git-command.service.ts";
import { THRONE_PROJECT_DIR } from "../git-lifecycle/git-worktree.service.ts";
import { TREE_BASE_DATA } from "../agentdata/tree-base-data.service.ts";
import { DELIVERY_EVIDENCE_DATA } from "../agentdata/delivery-evidence-data.service.ts";

async function findLedgerDeliveryCommit(
  name: string,
  requestedRepoRoot: string,
  dataDir?: string,
): Promise<string | undefined> {
  const record = await DELIVERY_EVIDENCE_DATA.read(name, dataDir);
  if (record === null) return undefined;
  try {
    const recordRepoRoot = await repoRoot(record.repo);
    return recordRepoRoot === requestedRepoRoot ? record.commit : undefined;
  } catch {
    return undefined;
  }
}

export async function findDeliveryCommitHash(
  name: string,
  repoRoot: string = THRONE_PROJECT_DIR,
  dataDir?: string,
): Promise<string | undefined> {
  return (await findDeliveryCommitHashes(name, repoRoot, dataDir))[0];
}

export async function findDeliveryCommitHashes(
  name: string,
  repoRoot: string = THRONE_PROJECT_DIR,
  dataDir?: string,
): Promise<string[]> {
  const ledgerCommit = await findLedgerDeliveryCommit(name, repoRoot, dataDir);
  return ledgerCommit === undefined ? [] : [ledgerCommit];
}

export async function hasDeliveryCommit(
  name: string,
  repoRoot: string = THRONE_PROJECT_DIR,
  dataDir?: string,
): Promise<boolean> {
  return (await findDeliveryCommitHash(name, repoRoot, dataDir)) !== undefined;
}

export async function resolveDeliveryRepoRoot(
  name: string,
  dataDir?: string,
): Promise<string> {
  try {
    const record = await TREE_BASE_DATA.read(name, dataDir);
    if (record?.repo === undefined) return THRONE_PROJECT_DIR;
    return await repoRoot(record.repo);
  } catch {
    return THRONE_PROJECT_DIR;
  }
}
