import path from "node:path";
import type { TreeBase } from "../agentdata/tree-base-data.service.ts";
import {
  currentBranch,
  currentCommit,
  repoRoot,
  runGit,
} from "../git-lifecycle/git-command.service.ts";
import {
  localBranchTip,
  readReachability,
} from "../git-lifecycle/branch-authority.ts";

interface NonCampaignBase {
  record: TreeBase;
  creationBase?: string;
}

function describeTipWithoutBase(facts: {
  projectDir: string;
  targetBranch: string;
  branchTip: string;
  requestedCommit: string;
}): string {
  return (
    `target branch "${facts.targetBranch}" in ${facts.projectDir} is at ${facts.branchTip}, ` +
    `which does not contain the filed base ${facts.requestedCommit}: the local branch is stale ` +
    `or has diverged from what was filed, and a worktree cut from it would build on the wrong ` +
    `code. Nothing was created. Bring the local branch to the filed base first — when it is ` +
    `not checked out anywhere: git -C ${facts.projectDir} branch -f ${facts.targetBranch} ` +
    `${facts.requestedCommit} — or correct the filed base, then launch again.`
  );
}

export async function resolveNonCampaignBase(opts: {
  name: string;
  projectDir: string;
  targetBranch?: string;
  requestedBase?: string;
  nonCampaign?: true;
}): Promise<
  { ok: true; base: NonCampaignBase } | { ok: false; reason: string }
> {
  const branch = opts.targetBranch ?? (await currentBranch(opts.projectDir));
  const branchTip =
    opts.targetBranch === undefined
      ? undefined
      : await localBranchTip(opts.projectDir, opts.targetBranch);
  if (opts.targetBranch !== undefined && branchTip === undefined) {
    return {
      ok: false,
      reason: `target branch "${opts.targetBranch}" does not exist locally in ${opts.projectDir}`,
    };
  }
  if (branchTip !== undefined && opts.requestedBase !== undefined) {
    // A requested base is a hint, not a lock: the target branch may have moved
    // on between the moment the caller read the tip and the moment we spawn.
    // Validate that the commit exists (a typo is still a caller error), then
    // always fork from the branch's CURRENT tip so a race never fails a spawn.
    let requestedCommit: string;
    try {
      requestedCommit = await runGit(
        ["rev-parse", "--verify", `${opts.requestedBase}^{commit}`],
        opts.projectDir,
      );
    } catch {
      return {
        ok: false,
        reason: `base "${opts.requestedBase}" is not a valid commit in ${opts.projectDir}`,
      };
    }
    if (requestedCommit !== branchTip) {
      const tipContainsBase = await readReachability(
        opts.projectDir,
        requestedCommit,
        branchTip,
      );
      if (tipContainsBase.code !== 0) {
        return {
          ok: false,
          reason: describeTipWithoutBase({
            projectDir: opts.projectDir,
            targetBranch: opts.targetBranch!,
            branchTip,
            requestedCommit,
          }),
        };
      }
      process.stderr.write(
        `spawn-git-tree: requested base ${requestedCommit} is behind the current tip ` +
          `${branchTip} of target branch "${opts.targetBranch}"; forking from the tip instead\n`,
      );
    }
  }

  const commit = branchTip ?? (await currentCommit(opts.projectDir));
  // Target-branch tip always wins over a requested base; without a target
  // branch the requested base is still the only fork point we have.
  const forkPoint = branchTip ?? opts.requestedBase;
  const targetRepoRoot = await repoRoot(opts.projectDir);
  return {
    ok: true,
    base: {
      record: {
        name: opts.name,
        base: forkPoint ?? commit,
        branch,
        commit,
        repo: opts.projectDir,
        repoRoot: targetRepoRoot,
        projectDir: path.relative(targetRepoRoot, opts.projectDir) || ".",
        notedAt: new Date().toISOString(),
        ...(opts.nonCampaign === true ? { nonCampaign: true as const } : {}),
      },
      ...(forkPoint !== undefined ? { creationBase: forkPoint } : {}),
    },
  };
}
