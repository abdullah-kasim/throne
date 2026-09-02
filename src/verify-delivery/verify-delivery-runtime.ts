// Exposes a path-wise blob delivery proof for `<name>` against its recorded
// target branch. The separate spawn-advance guard prevents a never-run
// candidate from passing vacuously.

import {
  localBranchTip,
  mergeBaseRevision,
  requireAdvancedSinceSpawn,
} from "../git-lifecycle/branch-authority.ts";
import {
  readPathWiseDeliveryIdentity,
  type PathWiseDeliveryIdentity,
} from "../git-lifecycle/path-wise-delivery.ts";
import { repoRoot } from "../git-lifecycle/git-command.service.ts";
import { TREE_BASE_DATA } from "../agentdata/tree-base-data.service.ts";
import { parseSingleNameToken } from "../shared-policy/single-name-parser-tail.ts";
import { findDeliveryCommitHash } from "../git-lifecycle/delivery-commit-proof.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

const USAGE =
  "Usage: ./bin/throne-cli verify-delivery [--data-dir <path>] <name>\n";

interface Parsed {
  dataDir?: string;
  name?: string;
}

/** Parse the single positional `<name>` — the tree/branch to verify. */
export function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--data-dir") {
      const dataDir = args[++i];
      if (dataDir === undefined || dataDir.startsWith("--")) {
        throw new Error('missing value for "--data-dir"');
      }
      parsed.dataDir = dataDir;
    } else {
      parsed.name = parseSingleNameToken(arg, parsed.name);
    }
  }
  return parsed;
}

/** A tree's recorded delivery provenance: the repo, spawn commit, and merge target branch. */
export interface TreeDeliveryRecord {
  /** The recorded target project dir, or undefined for a legacy/absent record. */
  repo?: string;
  /** The branch this tree was recorded against; also its recorded merge target. */
  branch?: string;
  /** The tip the branch was spawned from, or undefined for a legacy/absent record. */
  commit?: string;
}

/**
 * Resolve a tree's recorded delivery provenance — the `repo`, `branch`, and
 * `commit` fields of its `tree-base.json`. Each field degrades to `undefined`
 * independently when absent or unusable, mirroring
 * `merge-git-tree-runtime.ts`'s `readTreeMergeTarget`; `run` then FAILS
 * CLOSED on any missing field rather than guessing.
 */
const realReadTreeDeliveryRecord = async (
  name: string,
  dataDir?: string,
): Promise<TreeDeliveryRecord> => {
  const record = await TREE_BASE_DATA.read(name, dataDir);
  const branch: unknown = record?.branch;
  const commit: unknown = record?.commit;
  return {
    ...(record?.repo === undefined ? {} : { repo: record.repo }),
    ...(typeof branch === "string" && branch !== "" ? { branch } : {}),
    ...(typeof commit === "string" && commit !== "" ? { commit } : {}),
  };
};

/**
 * Injectable seams, mirroring `merge-git-tree-runtime.ts`'s `MergeGitTreeDeps`
 * shape. `readTreeDeliveryRecord` resolves the recorded provenance (defaults
 * to the real `tree-base.json` reader); `repoRoot`, `localBranchTip`,
 * `requireAdvancedSinceSpawn`, and `readPathWiseDeliveryIdentity` default to
 * the real git-lifecycle primitives so tests can substitute fakes without
 * touching a real repo. `out`/`err` default to the real stdio streams.
 */
export interface VerifyDeliveryDeps {
  readTreeDeliveryRecord?: (
    name: string,
    dataDir?: string,
  ) => Promise<TreeDeliveryRecord>;
  repoRoot?: (projectDir: string) => Promise<string>;
  localBranchTip?: (
    root: string,
    branch: string,
  ) => Promise<string | undefined>;
  requireAdvancedSinceSpawn?: (
    root: string,
    branch: string,
    tip: string,
    spawnCommit: string,
  ) => Promise<void>;
  mergeBaseRevision?: (root: string, a: string, b: string) => Promise<string>;
  readPathWiseDeliveryIdentity?: (
    root: string,
    baseRevision: string,
    deliveredBlobRevision: string,
    deliveryCommit: string,
    targetRevision: string,
  ) => Promise<PathWiseDeliveryIdentity>;
  out?: (message: string) => void;
  err?: (message: string) => void;
}

/**
 * The single path-wise blob proof against the recorded merge target underlying the CLI
 * command below — factored out so other production callers (the completion
 * reaper's queue auto-mark) can ask "is this genuinely delivered?" without
 * re-implementing or duplicating the tree comparison. Fails closed on any
 * missing provenance or tree-inspection failure; never guesses.
 */
export type DeliveryVerdict =
  | {
      status: "delivered";
      tip: string;
      targetBranch: string;
      contentDeliveryCommit?: string;
      candidateTree: string;
      targetTree: string;
      touchedPathCount?: number;
    }
  | { status: "missing-provenance"; missingFields: string }
  | { status: "branch-absent" }
  | { status: "not-delivered"; reason: string };

export async function checkDeliveryVerdict(
  name: string,
  dataDir: string | undefined,
  deps: VerifyDeliveryDeps = {},
): Promise<DeliveryVerdict> {
  const readTreeDeliveryRecord =
    deps.readTreeDeliveryRecord ?? realReadTreeDeliveryRecord;
  const resolveRepoRoot = deps.repoRoot ?? repoRoot;
  const branchTip = deps.localBranchTip ?? localBranchTip;
  const advancedSinceSpawn =
    deps.requireAdvancedSinceSpawn ?? requireAdvancedSinceSpawn;
  const compareDelivery =
    deps.readPathWiseDeliveryIdentity ?? readPathWiseDeliveryIdentity;
  const branchTargetMergeBase = deps.mergeBaseRevision ?? mergeBaseRevision;

  // Fail closed on a legacy/absent/unusable record: guessing a repo, target
  // branch, or spawn commit would make the verdict unfounded — exactly what
  // this check exists to never produce.
  const record = await readTreeDeliveryRecord(name, dataDir);
  if (
    record.repo === undefined ||
    record.branch === undefined ||
    record.commit === undefined
  ) {
    const missingFields = [
      ...(record.repo === undefined ? ["repo"] : []),
      ...(record.branch === undefined ? ["branch"] : []),
      ...(record.commit === undefined ? ["commit"] : []),
    ].join(" and ");
    return { status: "missing-provenance", missingFields };
  }

  try {
    const root = await resolveRepoRoot(record.repo);
    const tip = await branchTip(root, name);
    if (tip === undefined) {
      return { status: "branch-absent" };
    }
    await advancedSinceSpawn(root, name, tip, record.commit);
    const targetTip = await branchTip(root, record.branch);
    if (targetTip === undefined) {
      throw new Error(
        `recorded merge-target branch "${record.branch}" does not exist in the target repo`,
      );
    }
    const recordedDeliveryCommit = await findDeliveryCommitHash(
      name,
      root,
      dataDir,
    );
    const deliveryAnchor =
      recordedDeliveryCommit ?? (await branchTargetMergeBase(root, tip, targetTip));
    const identity = await compareDelivery(
      root,
      record.commit,
      tip,
      deliveryAnchor,
      targetTip,
    );
    return {
      status: "delivered",
      tip,
      targetBranch: record.branch,
      contentDeliveryCommit: deliveryAnchor,
      candidateTree: identity.candidateTree,
      targetTree: identity.targetTree,
      touchedPathCount: identity.touchedPaths.length,
    };
  } catch (verifyErr) {
    return {
      status: "not-delivered",
      reason:
        verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
    };
  }
}

export async function run(
  args: string[],
  deps: VerifyDeliveryDeps = {},
): Promise<number> {
  const out =
    deps.out ?? ((message: string): void => void process.stdout.write(message));
  const err =
    deps.err ?? ((message: string): void => void process.stderr.write(message));

  let parsed: Parsed;
  try {
    parsed = parseArgs(args);
  } catch (parseErr) {
    err(
      `verify-delivery: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n${renderEntranceRefusal({ reason: "verify-delivery entrance validation refused this invocation.", bypass: undefined, supervisorRoute: "Ask your supervisor for an allowed alternative invocation." })}\n${USAGE}`,
    );
    return 1;
  }

  if (parsed.name === undefined) {
    err(`verify-delivery: missing <name>\n${renderEntranceRefusal({ reason: "verify-delivery entrance validation requires <name>.", bypass: undefined, supervisorRoute: "Ask your supervisor for an allowed alternative invocation." })}\n${USAGE}`);
    return 1;
  }
  const name = parsed.name;

  const verdict = await checkDeliveryVerdict(name, parsed.dataDir, deps);
  switch (verdict.status) {
    case "missing-provenance":
      err(
        `verify-delivery: "${name}" has no usable recorded delivery provenance ` +
          `(tree-base.json is absent, legacy, or lacks ${verdict.missingFields}) — refusing ` +
          "to guess. Repair data/" +
          `${name}/tree-base.json (fields: repo, branch, commit) and re-run.\n`,
      );
      return 1;
    case "branch-absent":
      err(
        `NOT DELIVERED: branch "${name}" does not exist — nothing to verify.\n`,
      );
      return 1;
    case "not-delivered":
      err(`NOT DELIVERED: ${verdict.reason}\n`);
      return 1;
    case "delivered":
      out(
        `DELIVERED: "${name}" ${verdict.touchedPathCount ?? 0} touched path(s) ` +
          `are retained or changed after delivery on "${verdict.targetBranch}" ` +
          `(delivery tree ${verdict.candidateTree}; target tree ${verdict.targetTree}) — verified from git state.\n`,
      );
      return 0;
  }
}
