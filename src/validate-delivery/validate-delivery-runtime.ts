// A ledger-free, git-derived DELIVERED/NOT DELIVERED verdict comparing
// `<commit-hash>`'s touched paths with `<repo-path>`'s checked-out branch.

import {
  readPathWiseDeliveryIdentity,
  type PathWiseDeliveryIdentity,
} from "../git-lifecycle/path-wise-delivery.ts";
import {
  currentBranch,
  readGitStatus,
  repoRoot,
} from "../git-lifecycle/git-command.service.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

const USAGE =
  "Usage: ./bin/throne-cli validate-delivery <repo-path> <commit-hash>\n";

interface Parsed {
  repoPath?: string;
  commitHash?: string;
}

/** Parse the two positional arguments — the repo path and the commit hash. */
export function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = {};
  for (const arg of args) {
    if (arg.startsWith("--")) {
      throw new Error(`unknown flag "${arg}"`);
    } else if (parsed.repoPath === undefined) {
      parsed.repoPath = arg;
    } else if (parsed.commitHash === undefined) {
      parsed.commitHash = arg;
    } else {
      throw new Error(`unexpected argument "${arg}"`);
    }
  }
  return parsed;
}

export type WorkingTreeStatus = "clean" | "dirty";

export type ValidateDeliveryVerdict =
  | {
      status: "delivered";
      branch: string;
      workingTree: WorkingTreeStatus;
      candidateTree: string;
      targetTree: string;
      touchedPathCount: number;
    }
  | {
      status: "not-delivered";
      branch: string;
      reason: string;
      workingTree: WorkingTreeStatus;
    }
  | { status: "unknown-commit"; commitHash: string }
  | { status: "invalid-repo"; repoPath: string; reason: string };

/**
 * Injectable seams, mirroring `verify-delivery-runtime.ts`'s
 * `VerifyDeliveryDeps` shape. Each defaults to the real git-lifecycle
 * primitive so tests can substitute fakes without touching a real repo.
 */
export interface ValidateDeliveryDeps {
  repoRoot?: (projectDir: string) => Promise<string>;
  currentBranch?: (root: string) => Promise<string>;
  commitExists?: (root: string, commitHash: string) => Promise<boolean>;
  readPathWiseDeliveryIdentity?: (
    root: string,
    baseRevision: string,
    deliveredBlobRevision: string,
    deliveryCommit: string,
    targetRevision: string,
  ) => Promise<PathWiseDeliveryIdentity>;
  workingTreeStatus?: (root: string) => Promise<WorkingTreeStatus>;
  out?: (message: string) => void;
  err?: (message: string) => void;
}

async function realCommitExists(
  root: string,
  commitHash: string,
): Promise<boolean> {
  const result = await readGitStatus(
    ["cat-file", "-e", `${commitHash}^{commit}`],
    root,
  );
  return result.code === 0;
}

async function realWorkingTreeStatus(root: string): Promise<WorkingTreeStatus> {
  const result = await readGitStatus(["status", "--porcelain"], root);
  return result.stdout.trim() === "" ? "clean" : "dirty";
}

/**
 * The single path-wise blob proof against the current branch tip underlying the CLI command
 * below. Unlike `verify-delivery`, this reads no ledger file: the branch
 * checked is always the target repo's actual current checkout, never a
 * recorded value. Working-tree dirtiness is reported on the DELIVERED and
 * NOT DELIVERED cases alike and never itself changes the verdict status.
 */
export async function checkValidateDeliveryVerdict(
  repoPath: string,
  commitHash: string,
  deps: ValidateDeliveryDeps = {},
): Promise<ValidateDeliveryVerdict> {
  const resolveRepoRoot = deps.repoRoot ?? repoRoot;
  const resolveCurrentBranch = deps.currentBranch ?? currentBranch;
  const commitExists = deps.commitExists ?? realCommitExists;
  const compareDelivery =
    deps.readPathWiseDeliveryIdentity ?? readPathWiseDeliveryIdentity;
  const resolveWorkingTreeStatus =
    deps.workingTreeStatus ?? realWorkingTreeStatus;

  let root: string;
  try {
    root = await resolveRepoRoot(repoPath);
  } catch (rootErr) {
    return {
      status: "invalid-repo",
      repoPath,
      reason: rootErr instanceof Error ? rootErr.message : String(rootErr),
    };
  }

  if (!(await commitExists(root, commitHash))) {
    return { status: "unknown-commit", commitHash };
  }

  const branch = await resolveCurrentBranch(root);
  const workingTree = await resolveWorkingTreeStatus(root);

  try {
    const identity = await compareDelivery(
      root,
      `${commitHash}^`,
      commitHash,
      commitHash,
      branch,
    );
    return {
      status: "delivered",
      branch,
      workingTree,
      candidateTree: identity.candidateTree,
      targetTree: identity.targetTree,
      touchedPathCount: identity.touchedPaths.length,
    };
  } catch (deliveryError) {
    return {
      status: "not-delivered",
      branch,
      reason:
        deliveryError instanceof Error
          ? deliveryError.message
          : String(deliveryError),
      workingTree,
    };
  }
}

export async function run(
  args: string[],
  deps: ValidateDeliveryDeps = {},
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
      `validate-delivery: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n${renderEntranceRefusal({ reason: "validate-delivery entrance validation refused this invocation.", bypass: undefined, supervisorRoute: "Ask your supervisor for an allowed alternative invocation." })}\n${USAGE}`,
    );
    return 1;
  }

  if (parsed.repoPath === undefined || parsed.commitHash === undefined) {
    err(
      `validate-delivery: missing <repo-path> and/or <commit-hash>\n${renderEntranceRefusal({ reason: "validate-delivery entrance validation requires both <repo-path> and <commit-hash>.", bypass: undefined, supervisorRoute: "Ask your supervisor for an allowed alternative invocation." })}\n${USAGE}`,
    );
    return 1;
  }
  const { repoPath, commitHash } = parsed;

  const verdict = await checkValidateDeliveryVerdict(
    repoPath,
    commitHash,
    deps,
  );
  switch (verdict.status) {
    case "invalid-repo":
      err(
        `validate-delivery: "${verdict.repoPath}" does not resolve to a git repo: ${verdict.reason}\n`,
      );
      return 1;
    case "unknown-commit":
      err(
        `NOT DELIVERED: commit "${verdict.commitHash}" does not exist in this repo.\n`,
      );
      return 1;
    case "not-delivered":
      err(
        `NOT DELIVERED: ${verdict.reason} (checked branch "${verdict.branch}"; ` +
          `working tree ${verdict.workingTree}).\n`,
      );
      return 1;
    case "delivered":
      out(
        `DELIVERED: ${verdict.touchedPathCount} touched path(s) are retained or changed ` +
          `after delivery on "${verdict.branch}" (delivery tree ${verdict.candidateTree}; ` +
          `target tree ${verdict.targetTree}) — verified from git state ` +
          `(working tree ${verdict.workingTree}).\n`,
      );
      return 0;
  }
}
