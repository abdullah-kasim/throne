import { listLiveAgentStatusesAcrossSessions } from "../agent-statuses/agent-statuses-herdr.ts";
import { pathExists } from "../git-lifecycle/git-command.service.ts";
import { ownedHerdrClientPath } from "../herdr/herdr-client.ts";
import { startBackgroundHydration, type BackgroundHydration } from "./background-hydration.ts";
import { configuredEditor, editorCommandOf, launchEditor } from "./editor-launch.ts";
import type { ProcessResult } from "./forge-dependencies.ts";
import { ForgeRefusal, messageOf } from "./forge-refusal.ts";
import { environmentForForgejoGit } from "./forgejo-repository.ts";
import { FORGE } from "./host-forge.ts";
import { locateLocalRepository, productionCourtCheckoutLocations, type PullRequestRepository } from "./local-repository.ts";
import { parsePullRequestTarget, type PullRequestUrlTarget } from "./pull-request-forge.ts";
import { openForgejoApiOnThisHost, type ForgeContext } from "./pull-request-operations.ts";
import { PULL_REQUEST_STATE } from "./pull-request-shapes.ts";
import { pullRequestStatus, type ForgejoSide, type PullRequestStatus } from "./pull-request-status.ts";
import {
  chooseReviewCheckout,
  DIFFERENT_HEAD_REASON,
  REVIEW_CHECKOUT_HOW,
  type ReviewCheckout,
  type ReviewCheckoutHead,
  type ReviewCheckoutHow,
  type SkippedWorktree,
} from "./review-checkout.ts";
import { recordReviewedPullRequest } from "./reviewed-pull-request-record.ts";

export type PullRequestHead = PullRequestRepository & ReviewCheckoutHead;

export interface OpenPullRequestOptions {
  readonly explicitRepo: string | undefined;
  readonly editor: string | undefined;
  readonly printOnly: boolean;
}

export const DEPENDENCIES_ALREADY_CURRENT = "dependencies already current";

const PULL_REQUEST_PATH_SUFFIX = /\/pulls?\/\d+\/?$/;

const HOW_LINES: Readonly<Record<ReviewCheckoutHow, string>> = {
  [REVIEW_CHECKOUT_HOW.reused]: "reused a clean worktree already at the pull request head",
  [REVIEW_CHECKOUT_HOW.moved]: "moved the review worktree to the pull request head",
  [REVIEW_CHECKOUT_HOW.created]: "created a detached review worktree at the pull request head",
};

function repositoryUrlOf(pullRequestUrl: string): string {
  return pullRequestUrl.replace(PULL_REQUEST_PATH_SUFFIX, "");
}

function repositoryNameOf(pullRequestUrl: string): string {
  const target = parsePullRequestTarget(pullRequestUrl) as PullRequestUrlTarget;
  return `${target.owner}/${target.repository}`;
}

function holdingSideOf(status: PullRequestStatus): ForgejoSide {
  const { forgejo, github } = status;
  if (forgejo !== null && (forgejo.state === PULL_REQUEST_STATE.open || github === null)) return forgejo;
  return github!;
}

function resolvedSideOf(status: PullRequestStatus): ForgejoSide {
  return status.target.resolvedOn === FORGE.forgejo ? status.forgejo! : status.github!;
}

export function pullRequestHeadOf(status: PullRequestStatus): PullRequestHead {
  const resolved = resolvedSideOf(status);
  const holding = holdingSideOf(status);
  const sides = [status.forgejo, status.github].filter((side) => side !== null);
  return {
    repository: repositoryNameOf(resolved.url),
    repositoryUrls: sides.map((side) => repositoryUrlOf(side.url)),
    number: resolved.number,
    headBranch: holding.head,
    headSha: holding.headSha,
    holder: holding === status.forgejo ? FORGE.forgejo : FORGE.github,
    targetKind: status.target.kind,
  };
}

export async function liveAgentNames(): Promise<ReadonlySet<string>> {
  if (!(await pathExists(ownedHerdrClientPath()))) return new Set();
  try {
    const agents = await listLiveAgentStatusesAcrossSessions();
    return new Set(agents.flatMap((agent) => agent.tabLabel ?? agent.name ?? []));
  } catch (error) {
    throw new ForgeRefusal(`herdr could not list the live agents (${messageOf(error)}); nothing was opened, so no live agent's worktree is touched.`);
  }
}

async function fetchEnvironmentFor(context: ForgeContext, status: PullRequestStatus, head: PullRequestHead): Promise<NodeJS.ProcessEnv | undefined> {
  if (head.holder !== FORGE.forgejo) return undefined;
  const api = await openForgejoApiOnThisHost(context.dependencies);
  const owner = (parsePullRequestTarget(status.forgejo!.url) as PullRequestUrlTarget).owner;
  return environmentForForgejoGit(process.env, owner, api.token, api.rootUrl);
}

function isWorthReporting(skipped: SkippedWorktree): boolean {
  return skipped.reason !== DIFFERENT_HEAD_REASON;
}

function hydrationLine(hydration: BackgroundHydration): string {
  return hydration.outcome === "already current" ? DEPENDENCIES_ALREADY_CURRENT : `dependency log: ${hydration.logPath}`;
}

function openedLines(checkout: ReviewCheckout, editor: string, hydration: BackgroundHydration): string {
  return [
    checkout.path,
    HOW_LINES[checkout.how],
    ...checkout.skipped.filter(isWorthReporting).map((skipped) => `skipped ${skipped.path}: ${skipped.reason}`),
    `editor: ${editor}`,
    hydrationLine(hydration),
    "",
  ].join("\n");
}

export async function openPullRequest(context: ForgeContext, target: string, options: OpenPullRequestOptions): Promise<ProcessResult> {
  const status = await pullRequestStatus(context, target);
  const head = pullRequestHeadOf(status);
  const sourceCheckout = await locateLocalRepository(head, options.explicitRepo, productionCourtCheckoutLocations(), context.dependencies);
  const checkout = await chooseReviewCheckout(
    { checkout: sourceCheckout, head, liveAgentNames: await liveAgentNames(), fetchEnvironment: await fetchEnvironmentFor(context, status, head) },
    context.dependencies,
  );
  if (checkout.isReviewWorktree) await recordReviewedPullRequest(checkout.path, resolvedSideOf(status).url, context.dependencies);
  if (options.printOnly) return { exitCode: 0, stdout: `${checkout.path}\n`, stderr: "" };
  const editor = editorCommandOf(options.editor, await configuredEditor(), process.env);
  await launchEditor(checkout.path, editor);
  const hydration = await startBackgroundHydration(sourceCheckout, checkout.path);
  return { exitCode: 0, stdout: openedLines(checkout, editor, hydration), stderr: "" };
}
