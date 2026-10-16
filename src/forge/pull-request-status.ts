import { crossHostMediaLinksOfPair, type CrossHostMediaLinks, type PairBodies } from "./cross-host-media-links.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import type { ForgejoApi } from "./forgejo-api.ts";
import { findForgejoPullRequestAddress, forgejoAddressOfUrl, readForgejoPullRequestIfFound, type ForgejoPullRequestAddress } from "./forgejo-pull-requests.ts";
import { gitOutput } from "./forgejo-repository.ts";
import { githubViewArguments, runGithub } from "./github-pull-requests.ts";
import { decideHostForge, FORGE, type Forge, type HostForgeDecision } from "./host-forge.ts";
import { githubProgramOfUrl, mergeTargetOf, type MergeTarget } from "./merging-on-github.ts";
import {
  decideForgeHoldingPullRequest,
  forgejoTwinUrlOfGithubPullRequest,
  githubProgramForHost,
  parsePullRequestTarget,
  PUBLIC_GITHUB_HOST,
  type GithubProgram,
  type PullRequestTarget,
  type PullRequestUrlTarget,
} from "./pull-request-forge.ts";
import { openForgejoApiOnThisHost, type ForgeContext } from "./pull-request-operations.ts";
import { PULL_REQUEST_STATE, PULL_REQUEST_STATUS_FIELDS } from "./pull-request-shapes.ts";
import { githubTwinOf } from "./staged-pair.ts";

export const TARGET_KIND = { githubUrl: "github-url", forgejoUrl: "forgejo-url", number: "number", branch: "branch" } as const;
export type TargetKind = (typeof TARGET_KIND)[keyof typeof TARGET_KIND];

export const PULL_REQUEST_STAGE = {
  forgejoOnly: "forgejo-only",
  promoted: "promoted",
  githubOnly: "github-only",
  mergedOnGithub: "merged-on-github",
  closed: "closed",
} as const;
export type PullRequestStage = (typeof PULL_REQUEST_STAGE)[keyof typeof PULL_REQUEST_STAGE];

export interface ForgejoSide {
  readonly url: string;
  readonly number: number;
  readonly state: string;
  readonly draft: boolean;
  readonly base: string;
  readonly head: string;
  readonly headSha: string;
}

export interface GithubSide extends ForgejoSide {
  readonly mergedAt: string | null;
  readonly mergeCommit: string | null;
}

export interface PullRequestStatus {
  readonly target: { readonly asked: string; readonly kind: TargetKind; readonly resolvedOn: Forge; readonly how: string };
  readonly hostForge: Forge;
  readonly stage: PullRequestStage;
  readonly forgejo: ForgejoSide | null;
  readonly github: GithubSide | null;
  readonly inSync: boolean | null;
  readonly publishTo: Forge;
  readonly mergeTarget: MergeTarget | null;
  readonly mergeTargetRefusal: string | null;
  readonly crossHostMediaLinks: CrossHostMediaLinks;
}

interface GithubPullRequestJson {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly headRefOid: string;
  readonly mergedAt?: string | null;
  readonly mergeCommit?: { readonly oid: string } | null;
  readonly body: string;
}

interface SideRead<Side> {
  readonly side: Side;
  readonly body: string;
}

interface FoundSides {
  readonly resolvedOn: Forge;
  readonly how: string;
  readonly forgejo: ForgejoSide | null;
  readonly github: GithubSide | null;
  readonly bodies: PairBodies;
}

type GithubRead = ({ readonly found: true } & SideRead<GithubSide>) | { readonly found: false; readonly reason: string };

const ORIGIN_HOST_PATTERN = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:]/;

export function stageOf(forgejo: ForgejoSide | null, github: GithubSide | null): PullRequestStage {
  if (github?.state === PULL_REQUEST_STATE.merged) return PULL_REQUEST_STAGE.mergedOnGithub;
  if (github?.state === PULL_REQUEST_STATE.closed) return PULL_REQUEST_STAGE.closed;
  if (github !== null) return forgejo === null ? PULL_REQUEST_STAGE.githubOnly : PULL_REQUEST_STAGE.promoted;
  return forgejo?.state === PULL_REQUEST_STATE.open ? PULL_REQUEST_STAGE.forgejoOnly : PULL_REQUEST_STAGE.closed;
}

export function publishToOf(kind: TargetKind, stage: PullRequestStage, forgejo: ForgejoSide | null): Forge {
  if (kind === TARGET_KIND.githubUrl) return FORGE.github;
  if (kind === TARGET_KIND.forgejoUrl) return FORGE.forgejo;
  const livesOnGithub = stage === PULL_REQUEST_STAGE.githubOnly || stage === PULL_REQUEST_STAGE.mergedOnGithub || forgejo === null;
  return livesOnGithub ? FORGE.github : FORGE.forgejo;
}

function inSyncOf(forgejo: ForgejoSide | null, github: GithubSide | null): boolean | null {
  return forgejo === null || github === null ? null : forgejo.headSha === github.headSha;
}

function githubSideOf(pullRequest: GithubPullRequestJson): GithubSide {
  return {
    url: pullRequest.url,
    number: pullRequest.number,
    state: pullRequest.state,
    draft: pullRequest.isDraft,
    base: pullRequest.baseRefName,
    head: pullRequest.headRefName,
    headSha: pullRequest.headRefOid,
    mergedAt: pullRequest.mergedAt || null,
    mergeCommit: pullRequest.mergeCommit?.oid ?? null,
  };
}

async function readGithubSide(context: ForgeContext, targetText: string, program: GithubProgram): Promise<GithubRead> {
  const invocation = { program, repo: context.repo, bypass: false };
  const result = await runGithub(githubViewArguments(targetText, PULL_REQUEST_STATUS_FIELDS), invocation, context.dependencies);
  if (result.exitCode !== 0) return { found: false, reason: `${program} could not read ${targetText}: ${result.stderr.trim()}` };
  const pullRequest = JSON.parse(result.stdout) as GithubPullRequestJson;
  return { found: true, side: githubSideOf(pullRequest), body: pullRequest.body };
}

async function readForgejoSide(address: ForgejoPullRequestAddress, api: ForgejoApi): Promise<SideRead<ForgejoSide> | null> {
  const view = await readForgejoPullRequestIfFound(address, api);
  if (view === undefined) return null;
  const side = {
    url: view.url,
    number: view.number,
    state: view.state,
    draft: view.isDraft,
    base: view.baseRefName,
    head: view.headRefName,
    headSha: view.headSha,
  };
  return { side, body: view.body };
}

function sidesRead(resolvedOn: Forge, forgejo: SideRead<ForgejoSide> | null, github: SideRead<GithubSide> | null): Omit<FoundSides, "how"> {
  return {
    resolvedOn,
    forgejo: forgejo?.side ?? null,
    github: github?.side ?? null,
    bodies: { forgejo: forgejo?.body ?? null, github: github?.body ?? null },
  };
}

async function githubTwinOfForgejoSide(
  context: ForgeContext,
  forgejo: ForgejoSide,
  address: ForgejoPullRequestAddress,
  api: ForgejoApi,
): Promise<SideRead<GithubSide> | null> {
  const githubUrl = await githubTwinOf({ api, address, url: forgejo.url });
  if (githubUrl === undefined) return null;
  const read = await readGithubSide(context, githubUrl, githubProgramOfUrl(githubUrl));
  if (!read.found) throw new ForgeRefusal(`${forgejo.url} links the GitHub pull request ${githubUrl}, but ${read.reason}`);
  return read;
}

async function forgejoTwinOfGithubSide(context: ForgeContext, github: GithubSide, host: HostForgeDecision): Promise<SideRead<ForgejoSide> | null> {
  if (host.forge === FORGE.github) return null;
  const api = await openForgejoApiOnThisHost(context.dependencies);
  const twinUrl = await forgejoTwinUrlOfGithubPullRequest(parsePullRequestTarget(github.url) as PullRequestUrlTarget, api);
  if (twinUrl === undefined) return null;
  return readForgejoSide(forgejoAddressOfUrl(parsePullRequestTarget(twinUrl) as PullRequestUrlTarget), api);
}

async function originGithubProgram(context: ForgeContext): Promise<GithubProgram> {
  const originUrl = (await gitOutput(context.repo, ["remote", "get-url", "origin"], context.dependencies)) ?? "";
  return githubProgramForHost(ORIGIN_HOST_PATTERN.exec(originUrl)?.[1] ?? PUBLIC_GITHUB_HOST);
}

async function sidesFromForgejo(context: ForgeContext, address: ForgejoPullRequestAddress, api: ForgejoApi): Promise<Omit<FoundSides, "how"> | undefined> {
  const forgejo = await readForgejoSide(address, api);
  if (forgejo === null) return undefined;
  return sidesRead(FORGE.forgejo, forgejo, await githubTwinOfForgejoSide(context, forgejo.side, address, api));
}

async function sidesFromGithub(context: ForgeContext, targetText: string, program: GithubProgram, host: HostForgeDecision): Promise<Omit<FoundSides, "how"> | string> {
  const read = await readGithubSide(context, targetText, program);
  if (!read.found) return read.reason;
  return sidesRead(FORGE.github, await forgejoTwinOfGithubSide(context, read.side, host), read);
}

async function sidesOfForgejoUrl(context: ForgeContext, target: PullRequestUrlTarget): Promise<FoundSides> {
  const api = await openForgejoApiOnThisHost(context.dependencies);
  const sides = await sidesFromForgejo(context, forgejoAddressOfUrl(target), api);
  if (sides === undefined) throw new ForgeRefusal(`Forgejo has no pull request at ${target.text}; nothing else was looked at.`);
  return { ...sides, how: "read the Forgejo pull request at that URL, and its GitHub twin through its metadata comment" };
}

async function sidesOfGithubUrl(context: ForgeContext, target: PullRequestUrlTarget, program: GithubProgram, host: HostForgeDecision): Promise<FoundSides> {
  const sides = await sidesFromGithub(context, target.text, program, host);
  if (typeof sides === "string") throw new ForgeRefusal(`no GitHub pull request was found at ${target.text}: ${sides}`);
  const twinSearch = host.forge === FORGE.forgejo ? "through the open pull requests of the Forgejo copy" : "nowhere, because this host has no Forgejo";
  return { ...sides, how: `read the GitHub pull request at that URL with ${program}, and looked for its Forgejo twin ${twinSearch}` };
}

async function sidesOfNumberOrBranch(context: ForgeContext, target: PullRequestTarget, host: HostForgeDecision): Promise<FoundSides> {
  if (host.forge === FORGE.forgejo) {
    const api = await openForgejoApiOnThisHost(context.dependencies);
    const address = await findForgejoPullRequestAddress(context.repo, target, api, context.dependencies);
    const sides = address === undefined ? undefined : await sidesFromForgejo(context, address, api);
    if (sides !== undefined) return { ...sides, how: `found ${target.text} in this checkout's Forgejo copy, the host forge` };
  }
  const forgejoMiss = host.forge === FORGE.forgejo ? "this checkout's Forgejo copy has no such pull request" : "this host has no Forgejo";
  const program = await originGithubProgram(context);
  const sides = await sidesFromGithub(context, target.text, program, host);
  if (typeof sides === "string") throw new ForgeRefusal(`no pull request ${target.text} was found: ${forgejoMiss}; ${sides}`);
  return { ...sides, how: `${forgejoMiss}, so ${target.text} was read from this checkout's GitHub repository with ${program}` };
}

async function findSides(context: ForgeContext, target: PullRequestTarget, host: HostForgeDecision): Promise<{ kind: TargetKind; sides: FoundSides }> {
  if (target.kind !== "url") return { kind: target.kind, sides: await sidesOfNumberOrBranch(context, target, host) };
  const holder = await decideForgeHoldingPullRequest(target, context.dependencies);
  if (holder.forge === FORGE.forgejo) return { kind: TARGET_KIND.forgejoUrl, sides: await sidesOfForgejoUrl(context, target) };
  return { kind: TARGET_KIND.githubUrl, sides: await sidesOfGithubUrl(context, target, holder.program, host) };
}

export async function pullRequestStatus(context: ForgeContext, targetText: string): Promise<PullRequestStatus> {
  const target = parsePullRequestTarget(targetText);
  const host = await decideHostForge(context.dependencies);
  const { kind, sides } = await findSides(context, target, host);
  const { forgejo, github } = sides;
  const stage = stageOf(forgejo, github);
  return {
    target: { asked: targetText, kind, resolvedOn: sides.resolvedOn, how: sides.how },
    hostForge: host.forge,
    stage,
    forgejo,
    github,
    inSync: inSyncOf(forgejo, github),
    publishTo: publishToOf(kind, stage, forgejo),
    ...mergeTargetOf(github?.url ?? null, forgejo?.url ?? null),
    crossHostMediaLinks: await crossHostMediaLinksOfPair(sides.bodies, host.url, context.dependencies),
  };
}

function linesOf(prefix: string, value: unknown): string[] {
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, inner]) => linesOf(prefix === "" ? key : `${prefix}.${key}`, inner));
  }
  return [`${prefix}: ${value === null ? "none" : String(value)}`];
}

export function pullRequestStatusLines(status: PullRequestStatus): string {
  return `${linesOf("", status).join("\n")}\n`;
}
