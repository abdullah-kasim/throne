import { readRepositoryRegistry } from "../memory-recall/repository-registry.ts";
import { productionRecallDataDirectory } from "../memory-recall/recall-records.ts";
import { resolveRegentQueueDatabasePath } from "../regent-queue/regent-queue-database.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import { pathExists } from "../git-lifecycle/git-command.service.ts";
import type { ForgeDependencies } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import { readRecordedCheckouts, type RecordedCheckouts } from "./forgejo-checkouts.ts";
import { gitOutput, ORIGIN_REMOTE_NAME } from "./forgejo-repository.ts";

export interface PullRequestRepository {
  readonly repository: string;
  readonly repositoryUrls: readonly string[];
}

export interface CourtCheckoutLocations {
  readonly recallDataDirectory: string;
  readonly queueDatabasePath: string;
}

interface RemoteLocation {
  readonly host: string;
  readonly repositoryPath: string;
}

const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;
const CREDENTIALS_PREFIX = /^[^@/]*@/;
const HOST_PORT_AND_PATH = /^([^/:]+)(?::\d+(?=\/))?[/:](.+)$/;
const WORKTREE_LINE_PREFIX = "worktree ";
const BARE_LINE = "bare";

export function productionCourtCheckoutLocations(): CourtCheckoutLocations {
  return { recallDataDirectory: productionRecallDataDirectory(), queueDatabasePath: resolveRegentQueueDatabasePath() };
}

export function noLocalCloneMessage(repository: string): string {
  return `no local clone of ${repository}; pass --repo or clone it`;
}

function remoteLocationOf(url: string): RemoteLocation | undefined {
  const withoutScheme = url.trim().replace(SCHEME_PREFIX, "").replace(CREDENTIALS_PREFIX, "");
  const match = HOST_PORT_AND_PATH.exec(withoutScheme);
  if (match === null) return undefined;
  const repositoryPath = match[2]!.replace(/\/+$/, "").replace(/\.git$/, "").replace(/^\/+/, "");
  return { host: match[1]!.toLowerCase(), repositoryPath };
}

function repositoryIdentityOf(url: string): string | undefined {
  const location = remoteLocationOf(url);
  return location === undefined ? undefined : `${location.host}/${location.repositoryPath}`;
}

function isSameRepositoryUrl(left: string, right: string): boolean {
  const leftIdentity = repositoryIdentityOf(left);
  return leftIdentity !== undefined && leftIdentity === repositoryIdentityOf(right);
}

async function linkedWorktreesOfBareRepository(repository: string, dependencies: ForgeDependencies): Promise<readonly string[]> {
  const listing = (await gitOutput(repository, ["worktree", "list", "--porcelain"], dependencies)) ?? "";
  return listing
    .split("\n\n")
    .map((entry) => entry.split("\n"))
    .filter((lines) => !lines.includes(BARE_LINE))
    .flatMap((lines) => lines.filter((line) => line.startsWith(WORKTREE_LINE_PREFIX)))
    .map((line) => line.slice(WORKTREE_LINE_PREFIX.length));
}

async function firstExistingPath(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) if (await pathExists(candidate)) return candidate;
  return undefined;
}

async function workingCheckoutOf(candidate: string, dependencies: ForgeDependencies): Promise<string | undefined> {
  if (!(await pathExists(candidate))) return undefined;
  const isBare = await gitOutput(candidate, ["rev-parse", "--is-bare-repository"], dependencies);
  if (isBare === undefined) return undefined;
  if (isBare === "true") return firstExistingPath(await linkedWorktreesOfBareRepository(candidate, dependencies));
  return gitOutput(candidate, ["rev-parse", "--show-toplevel"], dependencies);
}

async function firstWorkingCheckout(candidates: readonly string[], dependencies: ForgeDependencies): Promise<string | undefined> {
  for (const candidate of candidates) {
    const checkout = await workingCheckoutOf(candidate, dependencies);
    if (checkout !== undefined) return checkout;
  }
  return undefined;
}

function recordedCheckoutsOfPullRequest(pullRequest: PullRequestRepository, recorded: RecordedCheckouts): readonly string[] {
  return pullRequest.repositoryUrls
    .map((url) => remoteLocationOf(url)?.repositoryPath)
    .flatMap((repositoryPath) => (repositoryPath === undefined || recorded[repositoryPath] === undefined ? [] : [recorded[repositoryPath]]));
}

async function queueTargetRepositories(queueDatabasePath: string): Promise<readonly string[]> {
  if (!(await pathExists(queueDatabasePath))) return [];
  const store = openRegentQueueStore(queueDatabasePath);
  try {
    const read = store.readAll();
    if (read.state !== "items") return [];
    return read.items.flatMap((row) => [row.targetRepo, row.launchEligibility?.targetRepo ?? null]).filter((repository) => repository !== null);
  } finally {
    store.close();
  }
}

async function readCourtCheckouts(locations: CourtCheckoutLocations): Promise<readonly string[]> {
  const registry = await readRepositoryRegistry({ dataDirectory: locations.recallDataDirectory, seedRepositories: () => Promise.resolve([]) });
  return [...new Set([...(await queueTargetRepositories(locations.queueDatabasePath)), ...registry.keys()])];
}

async function isCloneOfPullRequestRepository(checkout: string, pullRequest: PullRequestRepository, dependencies: ForgeDependencies): Promise<boolean> {
  const origin = await gitOutput(checkout, ["remote", "get-url", ORIGIN_REMOTE_NAME], dependencies);
  return origin !== undefined && pullRequest.repositoryUrls.some((url) => isSameRepositoryUrl(origin, url));
}

async function firstCourtCheckoutOfPullRequest(
  pullRequest: PullRequestRepository,
  locations: CourtCheckoutLocations,
  dependencies: ForgeDependencies,
): Promise<string | undefined> {
  for (const candidate of await readCourtCheckouts(locations)) {
    const checkout = await workingCheckoutOf(candidate, dependencies);
    if (checkout !== undefined && (await isCloneOfPullRequestRepository(checkout, pullRequest, dependencies))) return checkout;
  }
  return undefined;
}

async function explicitCheckoutOrRefuse(explicitRepo: string, dependencies: ForgeDependencies): Promise<string> {
  const checkout = await workingCheckoutOf(explicitRepo, dependencies);
  if (checkout === undefined) throw new ForgeRefusal(`${explicitRepo} is not a git checkout.`);
  return checkout;
}

export async function locateLocalRepository(
  pullRequest: PullRequestRepository,
  explicitRepo: string | undefined,
  locations: CourtCheckoutLocations,
  dependencies: ForgeDependencies,
): Promise<string> {
  if (explicitRepo !== undefined) return explicitCheckoutOrRefuse(explicitRepo, dependencies);
  const recorded = await firstWorkingCheckout(recordedCheckoutsOfPullRequest(pullRequest, await readRecordedCheckouts()), dependencies);
  if (recorded !== undefined) return recorded;
  const known = await firstCourtCheckoutOfPullRequest(pullRequest, locations, dependencies);
  if (known !== undefined) return known;
  throw new ForgeRefusal(noLocalCloneMessage(pullRequest.repository));
}
