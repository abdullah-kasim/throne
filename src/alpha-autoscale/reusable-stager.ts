import { listRegisteredAgentNames } from "../agent-statuses/agent-statuses-registry.ts";
import {
  DEFAULT_DATA_DIR,
  readSpawnSpec,
  type SpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import { hasUncommittedChanges } from "../git-lifecycle/checkout-standing.ts";
import { pathExists } from "../git-lifecycle/git-command.service.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import { isRegisteredStager } from "../stager-tree-refresh/stager-tree-refresh.ts";

export interface ReusableStager {
  readonly name: string;
  readonly worktree: string;
}

export interface ReusableStagerEvidence {
  readonly listRegisteredAgentNames: () => Promise<string[]>;
  readonly isRegisteredStager: (name: string) => Promise<boolean>;
  readonly readSpawnSpec: (name: string) => Promise<SpawnSpec | null>;
  readonly pathExists: (target: string) => Promise<boolean>;
  readonly hasUncommittedChanges: (worktree: string) => Promise<boolean>;
}

export const REAL_REUSABLE_STAGER_EVIDENCE: ReusableStagerEvidence = {
  listRegisteredAgentNames: () => listRegisteredAgentNames(),
  isRegisteredStager: (name) => isRegisteredStager(name, DEFAULT_DATA_DIR),
  readSpawnSpec: (name) => readSpawnSpec(name),
  pathExists,
  hasUncommittedChanges: (worktree) => hasUncommittedChanges(worktree),
};

interface DeadStagerRecord {
  readonly name: string;
  readonly spawnSpec: SpawnSpec;
}

function lastLaunchedAt(spawnSpec: SpawnSpec): number {
  const launchInstants = [spawnSpec.spawned_at, spawnSpec.switched_at]
    .map((instant) => Date.parse(instant ?? ""))
    .filter((instant) => !Number.isNaN(instant));
  return Math.max(0, ...launchInstants);
}

async function deadStagerRecords(
  liveAgentNames: readonly string[],
  evidence: ReusableStagerEvidence,
): Promise<DeadStagerRecord[]> {
  const records: DeadStagerRecord[] = [];
  for (const name of await evidence.listRegisteredAgentNames()) {
    if (liveAgentNames.some((liveName) => sameAgentName(liveName, name))) continue;
    if (!(await evidence.isRegisteredStager(name))) continue;
    const spawnSpec = await evidence.readSpawnSpec(name);
    if (spawnSpec !== null) records.push({ name, spawnSpec });
  }
  return records;
}

async function worktreeIsPresentAndClean(
  worktree: string,
  evidence: ReusableStagerEvidence,
): Promise<boolean> {
  return (
    (await evidence.pathExists(worktree)) &&
    !(await evidence.hasUncommittedChanges(worktree))
  );
}

export async function findStagerTheCourtWouldReuse(
  liveAgentNames: readonly string[],
  evidence: ReusableStagerEvidence = REAL_REUSABLE_STAGER_EVIDENCE,
): Promise<ReusableStager | null> {
  const newestFirst = (
    await deadStagerRecords(liveAgentNames, evidence)
  ).sort(
    (left, right) =>
      lastLaunchedAt(right.spawnSpec) - lastLaunchedAt(left.spawnSpec),
  );
  for (const { name, spawnSpec } of newestFirst) {
    if (await worktreeIsPresentAndClean(spawnSpec.cwd, evidence)) {
      return { name, worktree: spawnSpec.cwd };
    }
  }
  return null;
}
