// Creates a git worktree for a coding slice of a target project (default: the
// throne's own; another repo via `--repo <path>`). Omitting `--repo` still
// works for throne self-work, but warns loudly so a cross-repo campaign does
// not silently spawn against the wrong checkout.
//
// A campaign Shadow tree — a name shaped `shadow-<code>-…` — is MANDATED to
// base on its supervising Alpha's branch (branch name == Alpha agent name):
// the Alpha resolves from an explicit `--alpha <name>` or from registered
// Alphas' durable objective evidence, that Alpha's branch must exist in the
// target repo, and its recorded repo (when present) must agree with the spawn
// target. The recorded tree-base then names the Alpha's branch as the merge
// target, so the campaign accumulates on ONE branch instead of braiding into
// the checkout's current branch. `--non-campaign` is the one loud override,
// restoring current-branch basing for deliberate infrastructure trees (and it
// is required before `--base` may steer a campaign-shaped name). Every other
// name keeps current-branch basing untouched.
//
// ALL validation completes before anything is written: a refusal leaves no
// `tree-base.json`, no worktree, and no branch. On success the command notes
// the base being branched from (plus the resolved target repo) under
// `data/<name>/`, calls the GitTreeCreationService (which places the tree under
// `~/.throne/worktrees/...`, OUTSIDE the target repo), and prints the tree
// path. All coding happens in a tree, never the live checkout (AGENTS.md).

import path from "node:path";
import { realpath } from "node:fs/promises";
import { THRONE_PROJECT_DIR } from "../git-lifecycle/git-worktree.service.ts";
import { GitTreeCreationService } from "../git-lifecycle/git-tree-creation.service.ts";
import { repoRoot, runGit } from "../git-lifecycle/git-command.service.ts";
import { localBranchTip } from "../git-lifecycle/branch-authority.ts";
import { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { TREE_BASE_DATA } from "../agentdata/tree-base-data.service.ts";
import { LedgerDataService } from "../agentdata/ledger-data.service.ts";
import { listAgents } from "../herdr/herdr-runtime.service.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import {
  LIVE_ROLE_WORD_UNION,
  resolveCanonicalRoleWord,
} from "../shared-policy/role-word-union.ts";
import { parseSingleNameToken } from "../shared-policy/single-name-parser-tail.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { resolveNonCampaignBase } from "./non-campaign-base.ts";
import {
  campaignShadowToken,
  resolveCampaignAlpha,
} from "./campaign-alpha-resolution.ts";

const ledgerData = new LedgerDataService();
const treeCreation = new GitTreeCreationService();

const USAGE =
  "Usage: ./bin/throne-cli spawn-git-tree <name> [--repo <path>] [--base <ref>] [--target-branch <branch>] [--create-target-from <branch>] [--alpha <alpha-name>] [--non-campaign]\n" +
  "       Omitting --repo warns and uses the throne repo; cross-repo campaigns must pass --repo.\n" +
  "       A campaign Shadow name (shadow-<code>-…) bases on its supervising Alpha's branch,\n" +
  "       resolved from registered Alphas or an explicit --alpha. --non-campaign is the loud\n" +
  "       override restoring current-branch basing (and is required before --base applies\n" +
  "       to a campaign-shaped name).\n" +
  "       --create-target-from <mainline-branch> permits creating a missing --target-branch (a PR\n" +
  "       branch) at --base, forked conceptually from the named mainline; an existing target\n" +
  "       branch is never reset or re-forked, and the flag requires --target-branch and --base.\n";

interface Parsed {
  name?: string;
  base?: string;
  repo?: string;
  alpha?: string;
  targetBranch?: string;
  createTargetFrom?: string;
  nonCampaign?: boolean;
}

/**
 * Parse `<name>` (positional), an optional `--repo <path>` (the target project
 * dir; default the throne's own), an optional `--base <ref>`, an optional
 * `--alpha <alpha-name>` (the supervising Alpha a campaign Shadow bases on),
 * and the `--non-campaign` override flag.
 */
export function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--repo") {
      const value = args[i + 1];
      if (value === undefined || value === "") {
        throw new Error('flag "--repo" needs a value');
      }
      parsed.repo = value;
      i++;
    } else if (arg === "--base") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new Error('flag "--base" needs a value');
      }
      parsed.base = value;
      i++;
    } else if (arg === "--alpha") {
      const value = args[i + 1];
      if (value === undefined || value === "") {
        throw new Error('flag "--alpha" needs a value');
      }
      parsed.alpha = value;
      i++;
    } else if (arg === "--target-branch") {
      const value = args[i + 1];
      if (value === undefined || value === "") {
        throw new Error('flag "--target-branch" needs a value');
      }
      parsed.targetBranch = value;
      i++;
    } else if (arg === "--create-target-from") {
      const value = args[i + 1];
      if (value === undefined || value === "") {
        throw new Error('flag "--create-target-from" needs a value');
      }
      parsed.createTargetFrom = value;
      i++;
    } else if (arg === "--non-campaign") {
      parsed.nonCampaign = true;
    } else {
      parsed.name = parseSingleNameToken(arg, parsed.name);
    }
  }
  return parsed;
}

/** Resolve the target project dir; omission yields the throne default plus a loud warning. */
export function resolveTargetRepo(repo: string | undefined): {
  projectDir: string;
  warning?: string;
} {
  if (repo !== undefined) {
    return { projectDir: path.resolve(repo) };
  }

  return {
    projectDir: THRONE_PROJECT_DIR,
    warning:
      `spawn-git-tree: no --repo given - using the throne's own repo (${THRONE_PROJECT_DIR}); intended? ` +
      "A cross-repo campaign MUST pass --repo <path>: a tree spawned without it edits the THRONE checkout, not your target repo.\n",
  };
}

/**
 * Injectable data-dir seam: where the agent registry (`identity.md`,
 * `spawn.json`) and tree-base records live. `undefined` means the agentdata
 * functions' own default (the throne's real `data/`); hermetic tests inject a
 * temp dir so no test touches live ledgers.
 */
export interface SpawnGitTreeDeps {
  dataDir?: string;
  treeCreation?: GitTreeCreationService;
}

/** The validated base of a mandated campaign Shadow tree. */
interface CampaignBase {
  alphaName: string;
  /** The tip of `refs/heads/<alphaName>` in the target repo. */
  alphaTip: string;
}

/**
 * Run every campaign-mandate validation for a `shadow-<code>-…` tree — Alpha
 * resolution, Alpha-branch existence in the target repo, cross-repo
 * consistency of the Alpha's recorded repo — and return the validated base or
 * a refusal reason. Reads only, never writes, so a refusal leaves no trace.
 */
async function validateCampaignBase(opts: {
  name: string;
  explicitAlpha?: string;
  projectDir: string;
  dataDir?: string;
}): Promise<{ ok: true; base: CampaignBase } | { ok: false; reason: string }> {
  const resolution = await resolveCampaignAlpha({
    shadowName: opts.name,
    ...(opts.explicitAlpha === undefined
      ? {}
      : { explicitAlpha: opts.explicitAlpha }),
    registeredAgents: await ledgerData.listRegisteredAgents(opts.dataDir),
    readAlphaEvidence: (alphaName) => readSpawnSpec(alphaName, opts.dataDir),
  });
  if (!resolution.ok) {
    return resolution;
  }
  const alphaName = resolution.alphaName;

  const alphaTip = await localBranchTip(opts.projectDir, alphaName);
  if (alphaTip === undefined) {
    return {
      ok: false,
      reason:
        `supervising Alpha "${alphaName}" has no branch ` +
        `"refs/heads/${alphaName}" in the target repo (${opts.projectDir}) — ` +
        "wrong --repo, a reaped Alpha tree, or an infrastructure Shadow " +
        "needing --non-campaign",
    };
  }

  // A Shadow pointed at the wrong --repo is caught here: when the Alpha's own
  // tree-base records the repo it campaigns in, that repo's root must be the
  // spawn's target repo root. A legacy/absent record skips this check (the
  // branch-existence gate above still holds).
  const alphaTreeBase = await TREE_BASE_DATA.read(alphaName, opts.dataDir);
  if (alphaTreeBase !== null && typeof alphaTreeBase.repo === "string") {
    let alphaRepoRoot: string;
    let targetRepoRoot: string;
    try {
      [alphaRepoRoot, targetRepoRoot] = await Promise.all([
        repoRoot(alphaTreeBase.repo).then((root) => realpath(root)),
        repoRoot(opts.projectDir).then((root) => realpath(root)),
      ]);
    } catch (err) {
      return {
        ok: false,
        reason:
          `cannot compare supervising Alpha "${alphaName}"'s recorded repo ` +
          `(${alphaTreeBase.repo}) with the target repo (${opts.projectDir}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (alphaRepoRoot !== targetRepoRoot) {
      return {
        ok: false,
        reason:
          `supervising Alpha "${alphaName}"'s recorded repo root ` +
          `(${alphaRepoRoot}) is not the target repo root (${targetRepoRoot}); ` +
          "pass the Alpha's own repo via --repo, or --non-campaign for a " +
          "deliberate non-campaign tree",
      };
    }
  }

  return { ok: true, base: { alphaName, alphaTip } };
}

export async function run(
  args: string[],
  deps: SpawnGitTreeDeps = {},
): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    process.stderr.write(
      `spawn-git-tree: ${err instanceof Error ? err.message : String(err)}\n${renderEntranceRefusal(
        {
          reason: "spawn-git-tree entrance validation refused this invocation.",
          bypass: undefined,
          supervisorRoute:
            "Ask your supervisor for an allowed alternative invocation.",
        },
      )}\n${USAGE}`,
    );
    return 1;
  }

  if (parsed.name === undefined) {
    process.stderr.write(
      `spawn-git-tree: missing <name>\n${renderEntranceRefusal({
        reason: "spawn-git-tree entrance validation requires <name>.",
        bypass: undefined,
        supervisorRoute:
          "Ask your supervisor for an allowed alternative invocation.",
      })}\n${USAGE}`,
    );
    return 1;
  }
  const name = parsed.name;
  let dataDir = deps.dataDir;
  if (dataDir === undefined) {
    let liveAgents;
    try {
      liveAgents = await listAgents();
    } catch (error) {
      process.stderr.write(
        `spawn-git-tree: cannot resolve the authoritative live throne ledger: ${error instanceof Error ? error.message : String(error)}.\n`,
      );
      return 1;
    }
    const ledger = await ledgerData.resolveLiveLedger({
      invocationCwd: process.cwd(),
      liveAgents,
      sameAgentName,
    });
    if (!ledger.ok) {
      process.stderr.write(`spawn-git-tree: ${ledger.reason}.\n`);
      return 1;
    }
    dataDir = ledger.dataDir;
  }

  const refuse = (reason: string): number => {
    process.stderr.write(`spawn-git-tree: ${reason}\n`);
    return 1;
  };

  if (parsed.alpha !== undefined && parsed.nonCampaign === true) {
    return refuse("--alpha and --non-campaign are mutually exclusive");
  }
  const token = campaignShadowToken(name);
  if (
    (parsed.targetBranch !== undefined ||
      parsed.createTargetFrom !== undefined) &&
    token !== undefined &&
    parsed.nonCampaign !== true
  ) {
    return refuse(
      "--target-branch/--create-target-from do not apply to a campaign Shadow; its target is the supervising Alpha branch",
    );
  }
  if (parsed.alpha !== undefined && token === undefined) {
    return refuse(
      `--alpha only applies to a campaign Shadow name (shadow-<code>-…); ` +
        `"${name}" is not one`,
    );
  }

  const { projectDir, warning } = resolveTargetRepo(parsed.repo);
  if (warning !== undefined) {
    process.stderr.write(warning);
  }

  if (token !== undefined && parsed.nonCampaign !== true) {
    if (parsed.base !== undefined) {
      return refuse(
        `--base is not allowed for campaign Shadow "${name}" — the mandate ` +
          "bases it on its supervising Alpha's branch; pass --non-campaign " +
          "to own the base",
      );
    }

    const validated = await validateCampaignBase({
      name,
      ...(parsed.alpha === undefined ? {} : { explicitAlpha: parsed.alpha }),
      projectDir,
      ...(dataDir === undefined ? {} : { dataDir: dataDir }),
    });
    if (!validated.ok) {
      return refuse(validated.reason);
    }
    const { alphaName, alphaTip } = validated.base;
    const targetRepoRoot = await repoRoot(projectDir);
    const projectSubpath = path.relative(targetRepoRoot, projectDir) || ".";

    // Record the Alpha's branch as base AND merge target: the merge side
    // honours `branch`, so the whole campaign accumulates on the Alpha's
    // branch instead of the checkout's current branch.
    const campaignBase = {
      name,
      base: alphaName,
      branch: alphaName,
      commit: alphaTip,
      repo: projectDir,
      repoRoot: targetRepoRoot,
      projectDir: projectSubpath,
      notedAt: new Date().toISOString(),
    };
    await TREE_BASE_DATA.write(name, campaignBase, dataDir);

    // Transactional record-then-create: if the worktree/branch creation
    // fails (e.g. stale same-named branch collision), the just-written
    // record must not survive as phantom provenance for a tree that does
    // not exist — a later merge/reap would act on it.
    let treePath: string;
    try {
      const created = await (deps.treeCreation ?? treeCreation).create(
        name,
        alphaName,
        projectDir,
      );
      treePath = created.treePath;
      // Follow-up update once create() reports the real hydration outcome:
      // never a placeholder, and only written once a tree actually exists.
      await TREE_BASE_DATA.write(
        name,
        { ...campaignBase, dependencyHydration: created.dependencyHydration },
        dataDir,
      );
    } catch (err) {
      await TREE_BASE_DATA.remove(name, dataDir);
      throw err;
    }
    process.stdout.write(`${treePath}\n`);
    return 0;
  }

  if (parsed.createTargetFrom !== undefined) {
    // PR-mode target creation: bring a missing PR target branch into existence
    // at the authorized base before ordinary base resolution runs, so the
    // base==target-tip gate below holds by construction. An existing target
    // branch is left exactly as it is — never reset, never re-forked — so a
    // second campaign stacking onto the same PR branch delivers onto its
    // current tip instead of silently discarding the first campaign's work.
    if (parsed.targetBranch === undefined || parsed.base === undefined) {
      return refuse(
        "--create-target-from requires --target-branch (the PR branch) and --base " +
          "(the authorized fork commit); without both there is nothing to create. " +
          "Drop --create-target-from for a mainline spawn, or ask your supervisor " +
          "for the item's authorized PR launch metadata.",
      );
    }
    const mainlineTip = await localBranchTip(
      projectDir,
      parsed.createTargetFrom,
    );
    if (mainlineTip === undefined) {
      return refuse(
        `--create-target-from branch "${parsed.createTargetFrom}" does not exist locally in ${projectDir}; ` +
          "name the repo's real mainline branch, or ask your supervisor which branch the PR forks from.",
      );
    }
    const existingTarget = await localBranchTip(
      projectDir,
      parsed.targetBranch,
    );
    if (existingTarget === undefined) {
      let baseCommit: string;
      try {
        baseCommit = await runGit(
          ["rev-parse", "--verify", `${parsed.base}^{commit}`],
          projectDir,
        );
      } catch {
        return refuse(
          `--base "${parsed.base}" is not a valid commit in ${projectDir}, so the PR branch ` +
            `"${parsed.targetBranch}" cannot be created from it; re-check the item's authorized base commit.`,
        );
      }
      await runGit(["branch", parsed.targetBranch, baseCommit], projectDir);
      process.stderr.write(
        `spawn-git-tree: created PR branch "${parsed.targetBranch}" at ${baseCommit} ` +
          `(forked from "${parsed.createTargetFrom}") in ${projectDir}\n`,
      );
    }
  }

  const resolvedBase = await resolveNonCampaignBase({
    name,
    projectDir,
    ...(parsed.targetBranch === undefined
      ? {}
      : { targetBranch: parsed.targetBranch }),
    ...(parsed.base === undefined ? {} : { requestedBase: parsed.base }),
    ...(parsed.nonCampaign === true ? { nonCampaign: true as const } : {}),
  });
  if (!resolvedBase.ok) {
    return refuse(resolvedBase.reason);
  }
  const { record: nonCampaignBase, creationBase } = resolvedBase.base;
  await TREE_BASE_DATA.write(name, nonCampaignBase, dataDir);

  // Same transactional guarantee as the campaign-Shadow path above.
  let treePath: string;
  try {
    const created = await (deps.treeCreation ?? treeCreation).create(
      name,
      creationBase,
      projectDir,
    );
    treePath = created.treePath;
    // Same follow-up-update mechanism as the campaign-Shadow path above —
    // one mechanism recording hydration mode for both branches.
    await TREE_BASE_DATA.write(
      name,
      { ...nonCampaignBase, dependencyHydration: created.dependencyHydration },
      dataDir,
    );
  } catch (err) {
    await TREE_BASE_DATA.remove(name, dataDir);
    throw err;
  }
  process.stdout.write(`${treePath}\n`);
  return 0;
}
