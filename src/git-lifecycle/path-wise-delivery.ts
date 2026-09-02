import { readGitStatus, runGit } from "./git-command.service.ts";
import {
  readReachability,
  requiredMergeTargetTip,
  UnmergedLifecycleBranchError,
} from "./branch-authority.ts";

export interface RevisionTreeIdentity {
  candidateTree: string;
  targetTree: string;
  equal: boolean;
}

export interface PathDeliveryIdentity {
  path: string;
  deliveredBlob?: string;
  targetBlob?: string;
  outcome: "retained" | "post-delivery-divergence";
}

export interface PathWiseDeliveryIdentity {
  candidateTree: string;
  targetTree: string;
  touchedPaths: PathDeliveryIdentity[];
}

/** Compare the canonical Git tree objects carried by two revisions. Delivery
 * is a content claim, so squash-rewritten commit ancestry is deliberately not
 * part of this result. */
export async function readRevisionTreeIdentity(
  root: string,
  candidateRevision: string,
  targetRevision: string,
): Promise<RevisionTreeIdentity> {
  const [candidateTree, targetTree] = await Promise.all([
    runGit(["rev-parse", `${candidateRevision}^{tree}`], root),
    runGit(["rev-parse", `${targetRevision}^{tree}`], root),
  ]);
  return {
    candidateTree,
    targetTree,
    equal: candidateTree === targetTree,
  };
}

async function readTouchedPaths(
  root: string,
  baseRevision: string,
  deliveredRevision: string,
): Promise<string[]> {
  const result = await readGitStatus(
    ["diff", "--name-only", "-z", baseRevision, deliveredRevision, "--"],
    root,
  );
  if (result.code !== 0) {
    throw new Error(
      `cannot derive delivery-touched paths from "${baseRevision}" to ` +
        `"${deliveredRevision}": ${result.stderr.trim() || `git exited ${result.code}`}`,
    );
  }
  return result.stdout.split("\0").filter((entry) => entry.length > 0);
}

async function readPathBlob(
  root: string,
  revision: string,
  filePath: string,
): Promise<string | undefined> {
  const result = await readGitStatus(
    ["ls-tree", "-z", revision, "--", filePath],
    root,
  );
  if (result.code !== 0) {
    throw new Error(
      `cannot inspect path "${filePath}" at revision "${revision}": ` +
        `${result.stderr.trim() || `git exited ${result.code}`}`,
    );
  }
  if (result.stdout === "") return undefined;
  const separator = result.stdout.indexOf("\t");
  const metadata = separator === -1 ? "" : result.stdout.slice(0, separator);
  const fields = metadata.split(" ");
  if (fields.length !== 3 || fields[1] !== "blob" || fields[2] === "") {
    throw new Error(
      `cannot resolve a unique blob for path "${filePath}" at revision "${revision}"`,
    );
  }
  return fields[2];
}

async function requirePostDeliveryPathDivergence(
  root: string,
  deliveryCommit: string,
  targetRevision: string,
  filePath: string,
): Promise<void> {
  const retained = await readReachability(root, deliveryCommit, targetRevision);
  if (retained.code !== 0) {
    throw new UnmergedLifecycleBranchError(
      `path "${filePath}" differs and delivery commit "${deliveryCommit}" is not ` +
        `provably retained by target revision "${targetRevision}"`,
    );
  }
  const changedAfterDelivery = await readGitStatus(
    ["diff", "--quiet", deliveryCommit, targetRevision, "--", filePath],
    root,
  );
  if (changedAfterDelivery.code !== 1) {
    throw new UnmergedLifecycleBranchError(
      `path "${filePath}" differs without a provable target-side change after ` +
        `delivery commit "${deliveryCommit}"`,
    );
  }
}

export async function readPathWiseDeliveryIdentity(
  root: string,
  baseRevision: string,
  deliveredBlobRevision: string,
  deliveryCommit: string,
  targetRevision: string,
): Promise<PathWiseDeliveryIdentity> {
  const [trees, touchedPathNames] = await Promise.all([
    readRevisionTreeIdentity(root, deliveredBlobRevision, targetRevision),
    readTouchedPaths(root, baseRevision, deliveredBlobRevision),
  ]);
  const touchedPaths: PathDeliveryIdentity[] = [];
  for (const filePath of touchedPathNames) {
    const [deliveredBlob, targetBlob] = await Promise.all([
      readPathBlob(root, deliveredBlobRevision, filePath),
      readPathBlob(root, targetRevision, filePath),
    ]);
    if (deliveredBlob === targetBlob) {
      touchedPaths.push({
        path: filePath,
        ...(deliveredBlob === undefined ? {} : { deliveredBlob }),
        ...(targetBlob === undefined ? {} : { targetBlob }),
        outcome: "retained",
      });
      continue;
    }
    await requirePostDeliveryPathDivergence(
      root,
      deliveryCommit,
      targetRevision,
      filePath,
    );
    touchedPaths.push({
      path: filePath,
      ...(deliveredBlob === undefined ? {} : { deliveredBlob }),
      ...(targetBlob === undefined ? {} : { targetBlob }),
      outcome: "post-delivery-divergence",
    });
  }
  return {
    candidateTree: trees.candidateTree,
    targetTree: trees.targetTree,
    touchedPaths,
  };
}

export async function requireContentDeliveredToMergeTarget(
  root: string,
  branch: string,
  tip: string,
  mergeTargetBranch: string,
  deliveryCommit: string,
): Promise<PathWiseDeliveryIdentity> {
  const targetTip = await requiredMergeTargetTip(
    root,
    branch,
    mergeTargetBranch,
  );
  const deliveryReachability = await readReachability(
    root,
    deliveryCommit,
    targetTip,
  );
  if (deliveryReachability.code !== 0) {
    throw new UnmergedLifecycleBranchError(
      `recorded delivery commit "${deliveryCommit}" is not retained by ` +
        `merge-target branch "${mergeTargetBranch}"`,
    );
  }
  const identity = await readPathWiseDeliveryIdentity(
    root,
    `${deliveryCommit}^`,
    tip,
    deliveryCommit,
    targetTip,
  );
  return identity;
}
