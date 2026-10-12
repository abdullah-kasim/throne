import type { ForgeDependencies } from "./forge-dependencies.ts";
import { messageOf } from "./forge-refusal.ts";
import type { ForgejoApi } from "./forgejo-api.ts";
import { forgejoCopyName } from "./forgejo-checkouts.ts";
import { FORGEJO_PAGE_LIMIT, readOpenPullRequestRecords, type ForgejoPullRequestRecord } from "./forgejo-pull-requests.ts";
import {
  BRANCH_REF_PREFIX,
  BRANCH_RELATION,
  bringForgejoBranchForward,
  ensureForgejoRepository,
  forgejoBranchTips,
  gitOutput,
  ORIGIN_REMOTE_NAME,
  originTrackingRef,
  remoteBranchTips,
  runGitOrRefuse,
  type BranchRelation,
  type ForgejoRepository,
} from "./forgejo-repository.ts";

const BRANCH_SYNC_FAILED = "failed";

type BranchSyncOutcome = BranchRelation | typeof BRANCH_SYNC_FAILED;

interface BranchSyncResult {
  readonly outcome: BranchSyncOutcome;
  readonly reason?: string;
}

export interface OpenPullRequestBase {
  readonly number: number;
  readonly base: string;
}

export interface BranchSyncReport {
  readonly repository: string;
  readonly created: string[];
  readonly fastForwarded: string[];
  readonly current: string[];
  readonly ahead: string[];
  readonly diverged: string[];
  readonly failed: { readonly branch: string; readonly reason: string }[];
  readonly openPullRequestsNotCurrent: (OpenPullRequestBase & { readonly why: BranchSyncOutcome })[];
  readonly openPullRequestsOnForgejoOnlyBases: OpenPullRequestBase[];
}

const OUTCOMES_THAT_LEAVE_A_BRANCH_CURRENT: readonly BranchSyncOutcome[] = [
  BRANCH_RELATION.missing,
  BRANCH_RELATION.behind,
  BRANCH_RELATION.current,
];

async function fetchedOriginTips(repo: string, dependencies: ForgeDependencies): Promise<Map<string, string>> {
  const listing = await gitOutput(
    repo,
    ["for-each-ref", "--format=%(objectname) %(refname)", `refs/remotes/${ORIGIN_REMOTE_NAME}/`],
    dependencies,
  );
  const tips = new Map<string, string>();
  for (const line of (listing ?? "").split("\n")) {
    const [commit, ref] = line.split(" ");
    if (commit !== undefined && ref !== undefined) tips.set(ref, commit);
  }
  return tips;
}

async function fetchEveryOriginBranch(repo: string, dependencies: ForgeDependencies): Promise<Map<string, string>> {
  const advertised = await remoteBranchTips(repo, ORIGIN_REMOTE_NAME, undefined, dependencies);
  await runGitOrRefuse(repo, ["fetch", "--no-tags", ORIGIN_REMOTE_NAME, `+${BRANCH_REF_PREFIX}*:${originTrackingRef("*")}`], dependencies);
  const fetched = await fetchedOriginTips(repo, dependencies);
  const githubTips = new Map<string, string>();
  for (const branch of advertised.keys()) {
    const tip = fetched.get(originTrackingRef(branch));
    if (tip !== undefined) githubTips.set(branch, tip);
  }
  return githubTips;
}

function openPullRequestBasesOf(openPullRequests: readonly ForgejoPullRequestRecord[]): OpenPullRequestBase[] {
  return openPullRequests.map((record) => ({ number: record.number, base: record.base.ref }));
}

function branchesWithPullRequestBasesFirst(githubBranches: readonly string[], bases: readonly OpenPullRequestBase[]): string[] {
  const firstBranches = bases.map((pull) => pull.base).filter((base) => githubBranches.includes(base));
  return [...new Set([...firstBranches, ...githubBranches])];
}

async function syncBranch(
  repo: string,
  branch: string,
  githubTip: string,
  forgejoTip: string | undefined,
  repository: ForgejoRepository,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<BranchSyncResult> {
  try {
    return { outcome: await bringForgejoBranchForward(repo, branch, githubTip, forgejoTip, repository, api, dependencies) };
  } catch (error) {
    return { outcome: BRANCH_SYNC_FAILED, reason: messageOf(error) };
  }
}

function branchesWithOutcome(results: ReadonlyMap<string, BranchSyncResult>, outcome: BranchSyncOutcome): string[] {
  return [...results].filter(([, result]) => result.outcome === outcome).map(([branch]) => branch);
}

function branchSyncReportOf(
  repository: ForgejoRepository,
  results: ReadonlyMap<string, BranchSyncResult>,
  bases: readonly OpenPullRequestBase[],
): BranchSyncReport {
  const outcomeOfBase = (pull: OpenPullRequestBase) => results.get(pull.base)?.outcome;
  return {
    repository: forgejoCopyName(repository),
    created: branchesWithOutcome(results, BRANCH_RELATION.missing),
    fastForwarded: branchesWithOutcome(results, BRANCH_RELATION.behind),
    current: branchesWithOutcome(results, BRANCH_RELATION.current),
    ahead: branchesWithOutcome(results, BRANCH_RELATION.ahead),
    diverged: branchesWithOutcome(results, BRANCH_RELATION.diverged),
    failed: [...results]
      .filter(([, result]) => result.outcome === BRANCH_SYNC_FAILED)
      .map(([branch, result]) => ({ branch, reason: result.reason ?? "" })),
    openPullRequestsNotCurrent: bases.flatMap((pull) => {
      const why = outcomeOfBase(pull);
      return why === undefined || OUTCOMES_THAT_LEAVE_A_BRANCH_CURRENT.includes(why) ? [] : [{ ...pull, why }];
    }),
    openPullRequestsOnForgejoOnlyBases: bases.filter((pull) => outcomeOfBase(pull) === undefined),
  };
}

export async function syncForgejoBranches(repo: string, api: ForgejoApi, dependencies: ForgeDependencies): Promise<BranchSyncReport> {
  const repository = await ensureForgejoRepository(repo, undefined, api, dependencies);
  const githubTips = await fetchEveryOriginBranch(repo, dependencies);
  const forgejoTips = await forgejoBranchTips(repo, repository, api, dependencies);
  const bases = openPullRequestBasesOf(await readOpenPullRequestRecords(repository, FORGEJO_PAGE_LIMIT, api));
  const results = new Map<string, BranchSyncResult>();
  for (const branch of branchesWithPullRequestBasesFirst([...githubTips.keys()], bases)) {
    results.set(branch, await syncBranch(repo, branch, githubTips.get(branch)!, forgejoTips.get(branch), repository, api, dependencies));
  }
  return branchSyncReportOf(repository, results, bases);
}
