import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ForgeDependencies, ProcessResult } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import type { ForgejoApi } from "./forgejo-api.ts";
import { recordForgejoCheckout } from "./forgejo-checkouts.ts";

export const FORGEJO_REMOTE_NAME = "forgejo";
export const ORIGIN_REMOTE_NAME = "origin";
const BRANCH_REGISTRATION_WAIT_MILLISECONDS = 30_000;
const BRANCH_REGISTRATION_POLL_MILLISECONDS = 250;

export interface ForgejoRepository {
  readonly owner: string;
  readonly name: string;
}

export interface EnsuredForgejoRepository extends ForgejoRepository {
  readonly created: boolean;
}

export async function gitOutput(repo: string, args: readonly string[], dependencies: ForgeDependencies): Promise<string | undefined> {
  const result = await dependencies.runProcess("git", args, { cwd: repo });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

export async function runGitOrRefuse(
  repo: string,
  args: readonly string[],
  dependencies: ForgeDependencies,
  environment?: NodeJS.ProcessEnv,
): Promise<void> {
  const result = await dependencies.runProcess("git", args, { cwd: repo, environment });
  if (result.exitCode !== 0) {
    throw new ForgeRefusal(`git ${args.join(" ")} failed in ${repo} (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
}

function repositoryNameFromRemoteUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() ?? "";
}

async function forgejoRepositoryNameFor(repo: string, dependencies: ForgeDependencies): Promise<string> {
  const origin = await gitOutput(repo, ["remote", "get-url", ORIGIN_REMOTE_NAME], dependencies);
  if (origin !== undefined && origin !== "") return repositoryNameFromRemoteUrl(origin);
  const topLevel = await gitOutput(repo, ["rev-parse", "--show-toplevel"], dependencies);
  if (topLevel === undefined) throw new ForgeRefusal(`${repo} is not a git repository.`);
  return path.basename(topLevel);
}

export async function forgejoTokenUserLogin(api: ForgejoApi): Promise<string> {
  return (await api.readJson<{ login: string }>("user")).login;
}

export async function forgejoCopyNamed(name: string, api: ForgejoApi): Promise<ForgejoRepository> {
  return { owner: await forgejoTokenUserLogin(api), name };
}

export async function forgejoRepositoryFor(
  repo: string,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<ForgejoRepository> {
  return forgejoCopyNamed(await forgejoRepositoryNameFor(repo, dependencies), api);
}

export async function forgejoRemoteUrlOf(repo: string, dependencies: ForgeDependencies): Promise<string | undefined> {
  return gitOutput(repo, ["remote", "get-url", FORGEJO_REMOTE_NAME], dependencies);
}

export function forgejoRepositoryApiPath(repository: ForgejoRepository): string {
  return `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

export async function defaultBranchOf(repo: string, dependencies: ForgeDependencies): Promise<string> {
  const originHead = await gitOutput(repo, ["symbolic-ref", "--short", `refs/remotes/${ORIGIN_REMOTE_NAME}/HEAD`], dependencies);
  if (originHead === undefined || originHead === "") {
    throw new ForgeRefusal(`${repo} records no default branch for ${ORIGIN_REMOTE_NAME}; pass --base <branch>.`);
  }
  return originHead.slice(`${ORIGIN_REMOTE_NAME}/`.length);
}

export function environmentForForgejoGit(
  environment: NodeJS.ProcessEnv,
  login: string,
  token: string,
  forgejoRootUrl: string,
): NodeJS.ProcessEnv {
  const index = Number(environment.GIT_CONFIG_COUNT ?? "0") || 0;
  const credentials = Buffer.from(`${login}:${token}`).toString("base64");
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(index + 2),
    [`GIT_CONFIG_KEY_${index}`]: "http.extraHeader",
    [`GIT_CONFIG_VALUE_${index}`]: `Authorization: Basic ${credentials}`,
    [`GIT_CONFIG_KEY_${index + 1}`]: `http.${forgejoRootUrl}.proxy`,
    [`GIT_CONFIG_VALUE_${index + 1}`]: "",
  };
}

export const BRANCH_RELATION = {
  missing: "missing",
  behind: "behind",
  current: "current",
  ahead: "ahead",
  diverged: "diverged",
} as const;

export type BranchRelation = (typeof BRANCH_RELATION)[keyof typeof BRANCH_RELATION];

const ORIGIN_FETCH = { fetched: "fetched", absentOnOrigin: "absent-on-origin" } as const;

type OriginFetch = (typeof ORIGIN_FETCH)[keyof typeof ORIGIN_FETCH];

export const BRANCH_REF_PREFIX = "refs/heads/";

function forgejoGitEnvironment(repository: ForgejoRepository, api: ForgejoApi): NodeJS.ProcessEnv {
  return environmentForForgejoGit(process.env, repository.owner, api.token, api.rootUrl);
}

export async function pushToForgejo(
  repo: string,
  refspec: string,
  repository: ForgejoRepository,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<void> {
  await runGitOrRefuse(repo, ["push", FORGEJO_REMOTE_NAME, refspec], dependencies, forgejoGitEnvironment(repository, api));
}

export function originTrackingRef(branch: string): string {
  return `refs/remotes/${ORIGIN_REMOTE_NAME}/${branch}`;
}

function branchPatternsOf(branches: readonly string[]): string[] {
  return branches.length === 0 ? [`${BRANCH_REF_PREFIX}*`] : branches.map((branch) => `${BRANCH_REF_PREFIX}${branch}`);
}

function branchTipsFromListing(listing: string): Map<string, string> {
  const tips = new Map<string, string>();
  for (const line of listing.split("\n")) {
    const [commit, ref] = line.trim().split(/\s+/);
    if (commit !== undefined && ref?.startsWith(BRANCH_REF_PREFIX)) tips.set(ref.slice(BRANCH_REF_PREFIX.length), commit);
  }
  return tips;
}

export async function remoteBranchTips(
  repo: string,
  remote: string,
  environment: NodeJS.ProcessEnv | undefined,
  dependencies: ForgeDependencies,
  branches: readonly string[] = [],
): Promise<Map<string, string>> {
  const args = ["ls-remote", remote, ...branchPatternsOf(branches)];
  const result = await dependencies.runProcess("git", args, { cwd: repo, environment });
  if (result.exitCode !== 0) {
    throw new ForgeRefusal(`git ls-remote ${remote} failed in ${repo} (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  return branchTipsFromListing(result.stdout);
}

export async function forgejoBranchTips(
  repo: string,
  repository: ForgejoRepository,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
  branches: readonly string[] = [],
): Promise<Map<string, string>> {
  return remoteBranchTips(repo, FORGEJO_REMOTE_NAME, forgejoGitEnvironment(repository, api), dependencies, branches);
}

function originFetchRefusal(repo: string, branch: string, failure: ProcessResult): ForgeRefusal {
  return new ForgeRefusal(
    `git fetch ${ORIGIN_REMOTE_NAME} ${branch} failed in ${repo} (exit ${failure.exitCode}): ${failure.stderr.trim()}. The Forgejo copy of ${branch} was not refreshed and nothing was pushed, because a base that is not fetched from GitHub first may be stale; rerun once GitHub can be reached.`,
  );
}

async function fetchOriginBranch(repo: string, branch: string, dependencies: ForgeDependencies): Promise<OriginFetch> {
  const refspec = `+${BRANCH_REF_PREFIX}${branch}:${originTrackingRef(branch)}`;
  const fetch = await dependencies.runProcess("git", ["fetch", "--no-tags", ORIGIN_REMOTE_NAME, refspec], { cwd: repo });
  if (fetch.exitCode === 0) return ORIGIN_FETCH.fetched;
  const advertised = await gitOutput(repo, ["ls-remote", ORIGIN_REMOTE_NAME, `${BRANCH_REF_PREFIX}${branch}`], dependencies);
  if (advertised === "") return ORIGIN_FETCH.absentOnOrigin;
  throw originFetchRefusal(repo, branch, fetch);
}

async function freshBaseRefFor(repo: string, branch: string, dependencies: ForgeDependencies): Promise<string> {
  const fetched = await fetchOriginBranch(repo, branch, dependencies);
  return fetched === ORIGIN_FETCH.fetched ? originTrackingRef(branch) : `${BRANCH_REF_PREFIX}${branch}`;
}

export async function fetchForgejoBranch(
  repo: string,
  branch: string,
  repository: ForgejoRepository,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<string> {
  const forgejoBranch = `refs/remotes/${FORGEJO_REMOTE_NAME}/${branch}`;
  await runGitOrRefuse(
    repo,
    ["fetch", "--no-tags", FORGEJO_REMOTE_NAME, `+${BRANCH_REF_PREFIX}${branch}:${forgejoBranch}`],
    dependencies,
    forgejoGitEnvironment(repository, api),
  );
  return forgejoBranch;
}

export async function isAncestor(repo: string, ancestor: string, descendant: string, dependencies: ForgeDependencies): Promise<boolean> {
  return (await dependencies.runProcess("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repo })).exitCode === 0;
}

async function forgejoBranchRelation(
  repo: string,
  branch: string,
  sourceTip: string,
  forgejoTip: string | undefined,
  repository: ForgejoRepository,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<BranchRelation> {
  if (forgejoTip === undefined) return BRANCH_RELATION.missing;
  if (forgejoTip === sourceTip) return BRANCH_RELATION.current;
  const forgejoCopy = await fetchForgejoBranch(repo, branch, repository, api, dependencies);
  if (await isAncestor(repo, sourceTip, forgejoCopy, dependencies)) return BRANCH_RELATION.ahead;
  if (await isAncestor(repo, forgejoCopy, sourceTip, dependencies)) return BRANCH_RELATION.behind;
  return BRANCH_RELATION.diverged;
}

export async function bringForgejoBranchForward(
  repo: string,
  branch: string,
  sourceTip: string,
  forgejoTip: string | undefined,
  repository: ForgejoRepository,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<BranchRelation> {
  const relation = await forgejoBranchRelation(repo, branch, sourceTip, forgejoTip, repository, api, dependencies);
  if (relation === BRANCH_RELATION.missing || relation === BRANCH_RELATION.behind) {
    await pushToForgejo(repo, `${sourceTip}:${BRANCH_REF_PREFIX}${branch}`, repository, api, dependencies);
  }
  return relation;
}

function divergedBaseRefusal(baseBranch: string, forgejoTip: string | undefined, base: string, baseTip: string): ForgeRefusal {
  return new ForgeRefusal(
    `Forgejo refused the base branch ${baseBranch}: the Forgejo copy is at ${forgejoTip} and ${base} is at ${baseTip}, and neither contains the other. It is never force-pushed, so bring the Forgejo copy of ${baseBranch} back in line with the base by hand first.`,
  );
}

async function commitOf(repo: string, ref: string, dependencies: ForgeDependencies): Promise<string> {
  const commit = await gitOutput(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], dependencies);
  if (commit === undefined || commit === "") throw new ForgeRefusal(`${repo} has no ${ref} to copy to Forgejo.`);
  return commit;
}

async function refreshForgejoBase(
  repo: string,
  baseBranch: string,
  repository: ForgejoRepository,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<void> {
  const base = await freshBaseRefFor(repo, baseBranch, dependencies);
  const baseTip = await commitOf(repo, base, dependencies);
  const forgejoTip = (await forgejoBranchTips(repo, repository, api, dependencies, [baseBranch])).get(baseBranch);
  const relation = await bringForgejoBranchForward(repo, baseBranch, baseTip, forgejoTip, repository, api, dependencies);
  if (relation === BRANCH_RELATION.diverged) throw divergedBaseRefusal(baseBranch, forgejoTip, base, baseTip);
}

async function ensureForgejoCopyOf(
  repo: string,
  base: string | undefined,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<EnsuredForgejoRepository> {
  const repository = await forgejoRepositoryFor(repo, api, dependencies);
  const hasForgejoRemote = (await forgejoRemoteUrlOf(repo, dependencies)) !== undefined;
  const existsOnForgejo = (await api.readJsonIfFound(forgejoRepositoryApiPath(repository))) !== undefined;
  if (hasForgejoRemote && existsOnForgejo) return { ...repository, created: false };
  const baseBranch = base ?? (await defaultBranchOf(repo, dependencies));
  if (!existsOnForgejo) await api.sendJson("POST", "user/repos", { name: repository.name, private: true });
  if (!hasForgejoRemote) {
    const cloneUrl = `${api.rootUrl}${repository.owner}/${repository.name}.git`;
    await runGitOrRefuse(repo, ["remote", "add", FORGEJO_REMOTE_NAME, cloneUrl], dependencies);
  }
  await refreshForgejoBase(repo, baseBranch, repository, api, dependencies);
  return { ...repository, created: !existsOnForgejo };
}

export async function ensureForgejoRepository(
  repo: string,
  base: string | undefined,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<EnsuredForgejoRepository> {
  const ensured = await ensureForgejoCopyOf(repo, base, api, dependencies);
  await recordForgejoCheckout(ensured, repo);
  return ensured;
}

export async function pushBranchToForgejo(
  repo: string,
  branch: string,
  base: string | undefined,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<EnsuredForgejoRepository> {
  const repository = await ensureForgejoRepository(repo, base, api, dependencies);
  await refreshForgejoBase(repo, base ?? (await defaultBranchOf(repo, dependencies)), repository, api, dependencies);
  await pushToForgejo(repo, `${BRANCH_REF_PREFIX}${branch}:${BRANCH_REF_PREFIX}${branch}`, repository, api, dependencies);
  return repository;
}

function branchApiPath(repository: ForgejoRepository, branch: string): string {
  return `${forgejoRepositoryApiPath(repository)}/branches/${branch.split("/").map(encodeURIComponent).join("/")}`;
}

export async function waitUntilForgejoRegistersBranch(repository: ForgejoRepository, branch: string, api: ForgejoApi): Promise<void> {
  const deadline = Date.now() + BRANCH_REGISTRATION_WAIT_MILLISECONDS;
  while ((await api.readJsonIfFound(branchApiPath(repository, branch))) === undefined) {
    if (Date.now() >= deadline) {
      throw new ForgeRefusal(
        `Forgejo still does not know the pushed branch ${branch} in ${repository.owner}/${repository.name} after ${BRANCH_REGISTRATION_WAIT_MILLISECONDS / 1000} seconds, so no pull request was opened. Rerun the same command once Forgejo lists the branch.`,
      );
    }
    await delay(BRANCH_REGISTRATION_POLL_MILLISECONDS);
  }
}
