import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ForgeDependencies, ProcessResult } from "./forge-dependencies.ts";
import { syncForgejoBranches, type BranchSyncReport } from "./branch-sync.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import { openForgejoApi, type ForgejoApi } from "./forgejo-api.ts";
import {
  attachToForgejoPullRequest,
  commentOnForgejoPullRequest,
  createForgejoPullRequest,
  detachFromForgejoPullRequest,
  diffForgejoPullRequest,
  editForgejoPullRequest,
  listOpenForgejoPullRequests,
  renderMarkdownOnForgejo,
  viewForgejoPullRequest,
} from "./forgejo-pull-requests.ts";
import { ensureForgejoRepository, pushBranchToForgejo } from "./forgejo-repository.ts";
import { readForgejoSite } from "./forgejo-site.ts";
import { textSafeForGithub } from "./github-bound-text.ts";
import {
  githubCommentArguments,
  githubCreateArguments,
  githubDiffArguments,
  githubEditArguments,
  githubListOpenArguments,
  githubPushArguments,
  githubRenderMarkdownArguments,
  githubViewArguments,
  runGithub,
} from "./github-pull-requests.ts";
import { decideHostForge, FORGE } from "./host-forge.ts";
import {
  decidePullRequestForge,
  GITHUB_PROGRAM,
  parsePullRequestTarget,
  type GithubProgram,
  type PullRequestTarget,
} from "./pull-request-forge.ts";
import { refuseGithubWriteWhereRepositoryLandsOnMain } from "./repository-lands-on-main.ts";
import { bodyKeepingSelfReviewRecord } from "./staging-records.ts";

export interface ForgeContext {
  readonly repo: string;
  readonly bypass: boolean;
  readonly dependencies: ForgeDependencies;
}

type ForgejoOperation<T> = (api: ForgejoApi) => Promise<T>;
type GithubOperation = (program: GithubProgram) => Promise<ProcessResult>;

function printedLine(text: string): ProcessResult {
  return { exitCode: 0, stdout: text.endsWith("\n") ? text : `${text}\n`, stderr: "" };
}

export function printedJson(value: unknown): ProcessResult {
  return printedLine(JSON.stringify(value));
}

export async function openForgejoApiOnThisHost(dependencies: ForgeDependencies): Promise<ForgejoApi> {
  const site = await readForgejoSite();
  if (site === undefined) throw new ForgeRefusal("this host has no Forgejo install marker, so there is no Forgejo to talk to.");
  return openForgejoApi(site.rootUrl, dependencies);
}

async function onRepositoryForge(
  context: ForgeContext,
  forgejo: ForgejoOperation<ProcessResult>,
  github: GithubOperation,
): Promise<ProcessResult> {
  const host = await decideHostForge(context.dependencies);
  if (host.forge === FORGE.github) return github(GITHUB_PROGRAM.github);
  return forgejo(await openForgejoApiOnThisHost(context.dependencies));
}

async function onPullRequestForge(
  context: ForgeContext,
  targetText: string,
  forgejo: (api: ForgejoApi, target: PullRequestTarget) => Promise<ProcessResult>,
  github: GithubOperation,
): Promise<ProcessResult> {
  const target = parsePullRequestTarget(targetText);
  const decision = await decidePullRequestForge(target, context.dependencies);
  if (decision.forge === FORGE.github) return github(decision.program);
  const forgejoTarget = decision.twinUrl === undefined ? target : parsePullRequestTarget(decision.twinUrl);
  return forgejo(await openForgejoApiOnThisHost(context.dependencies), forgejoTarget);
}

function github(context: ForgeContext, program: GithubProgram, args: readonly string[]): Promise<ProcessResult> {
  return runGithub(args, { program, repo: context.repo, bypass: context.bypass }, context.dependencies);
}

async function writeToGithubUnlessRepositoryLandsOnMain(
  context: ForgeContext,
  githubWrite: string,
  write: () => Promise<ProcessResult>,
): Promise<ProcessResult> {
  await refuseGithubWriteWhereRepositoryLandsOnMain(context.repo, githubWrite, context.dependencies);
  return write();
}

async function sendBodyFileToGithub(
  context: ForgeContext,
  bodyFile: string,
  send: (githubBodyFile: string) => Promise<ProcessResult>,
): Promise<ProcessResult> {
  const site = await readForgejoSite();
  if (site === undefined) return send(bodyFile);
  const body = await readFile(bodyFile, "utf8");
  const githubBody = await textSafeForGithub(body, `the body file ${bodyFile}`, site.rootUrl, context.dependencies);
  const folder = await mkdtemp(path.join(tmpdir(), "forge-github-body-"));
  try {
    const githubBodyFile = path.join(folder, path.basename(bodyFile));
    await writeFile(githubBodyFile, `${githubBody}\n`);
    return await send(githubBodyFile);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

function refuseWithoutForgejo(): never {
  throw new ForgeRefusal("this host's forge is GitHub; a Forgejo copy is only made on a host with Forgejo installed.");
}

export async function ensureRepository(context: ForgeContext, base: string | undefined): Promise<ProcessResult> {
  return onRepositoryForge(
    context,
    async (api) => printedJson(await ensureForgejoRepository(context.repo, base, api, context.dependencies)),
    refuseWithoutForgejo,
  );
}

function divergedBranchLog(report: BranchSyncReport): string {
  return report.diverged
    .map((branch) => `forge sync-branches: ${branch} diverged between GitHub and Forgejo in ${report.repository}; it was left alone, never force-pushed.\n`)
    .join("");
}

export async function syncBranches(context: ForgeContext): Promise<ProcessResult> {
  return onRepositoryForge(
    context,
    async (api) => {
      const report = await syncForgejoBranches(context.repo, api, context.dependencies);
      return { ...printedJson(report), exitCode: report.failed.length > 0 ? 1 : 0, stderr: divergedBranchLog(report) };
    },
    refuseWithoutForgejo,
  );
}

export async function pushBranch(context: ForgeContext, branch: string, base: string | undefined): Promise<ProcessResult> {
  return onRepositoryForge(
    context,
    async (api) => printedJson({ ...(await pushBranchToForgejo(context.repo, branch, base, api, context.dependencies)), branch }),
    () => context.dependencies.runProcess("git", githubPushArguments(branch), { cwd: context.repo }),
  );
}

export async function createPullRequest(
  context: ForgeContext,
  request: { readonly title: string; readonly bodyFile: string; readonly base: string; readonly head: string; readonly draft: boolean },
): Promise<ProcessResult> {
  return onRepositoryForge(
    context,
    async (api) => {
      const body = await readFile(request.bodyFile, "utf8");
      const created = await createForgejoPullRequest(context.repo, { ...request, body }, api, context.dependencies);
      return printedLine(created.url);
    },
    (program) => writeToGithubUnlessRepositoryLandsOnMain(context, "Opening a GitHub pull request", () => github(context, program, githubCreateArguments(request))),
  );
}

export async function viewPullRequest(context: ForgeContext, target: string): Promise<ProcessResult> {
  return onPullRequestForge(
    context,
    target,
    async (api, parsed) => printedJson(await viewForgejoPullRequest(context.repo, parsed, api, context.dependencies)),
    (program) => github(context, program, githubViewArguments(target)),
  );
}

export async function editPullRequest(
  context: ForgeContext,
  target: string,
  change: { readonly title?: string; readonly bodyFile?: string },
): Promise<ProcessResult> {
  const { title, bodyFile } = change;
  return onPullRequestForge(
    context,
    target,
    async (api, parsed) => {
      const body =
        bodyFile === undefined
          ? undefined
          : bodyKeepingSelfReviewRecord((await viewForgejoPullRequest(context.repo, parsed, api, context.dependencies)).body, await readFile(bodyFile, "utf8"));
      return printedLine((await editForgejoPullRequest(context.repo, parsed, { title, body }, api, context.dependencies)).url);
    },
    (program) =>
      writeToGithubUnlessRepositoryLandsOnMain(context, "Editing a GitHub pull request", () =>
        bodyFile === undefined
          ? github(context, program, githubEditArguments(target, { title }))
          : sendBodyFileToGithub(context, bodyFile, (githubBodyFile) => github(context, program, githubEditArguments(target, { title, bodyFile: githubBodyFile }))),
      ),
  );
}

export async function listOpenPullRequests(
  context: ForgeContext,
  limit: number,
  timeoutMilliseconds?: number,
): Promise<ProcessResult> {
  return onRepositoryForge(
    context,
    async (api) => printedJson(await listOpenForgejoPullRequests(context.repo, limit, api, context.dependencies)),
    (program) =>
      runGithub(
        githubListOpenArguments(limit),
        { program, repo: context.repo, bypass: context.bypass, timeoutMilliseconds },
        context.dependencies,
      ),
  );
}

export async function diffPullRequest(context: ForgeContext, target: string): Promise<ProcessResult> {
  return onPullRequestForge(
    context,
    target,
    async (api, parsed) => printedLine(await diffForgejoPullRequest(context.repo, parsed, api, context.dependencies)),
    (program) => github(context, program, githubDiffArguments(target)),
  );
}

export async function commentOnPullRequest(context: ForgeContext, target: string, bodyFile: string): Promise<ProcessResult> {
  return onPullRequestForge(
    context,
    target,
    async (api, parsed) => {
      const body = await readFile(bodyFile, "utf8");
      return printedLine(await commentOnForgejoPullRequest(context.repo, parsed, body, api, context.dependencies));
    },
    (program) =>
      writeToGithubUnlessRepositoryLandsOnMain(context, "Commenting on a GitHub pull request", () =>
        sendBodyFileToGithub(context, bodyFile, (githubBodyFile) => github(context, program, githubCommentArguments(target, githubBodyFile))),
      ),
  );
}

export async function attachToPullRequest(context: ForgeContext, target: string, filePath: string): Promise<ProcessResult> {
  return onPullRequestForge(
    context,
    target,
    async (api, parsed) => printedJson(await attachToForgejoPullRequest(context.repo, parsed, filePath, api, context.dependencies)),
    () => {
      throw new ForgeRefusal(
        "GitHub has no upload that returns an attachment URL on its own; a GitHub pull request gets its media through pr-media's `gh pr edit --attach` publish.",
      );
    },
  );
}

export async function detachFromPullRequest(context: ForgeContext, target: string, url: string): Promise<ProcessResult> {
  return onPullRequestForge(
    context,
    target,
    async (api, parsed) => printedJson(await detachFromForgejoPullRequest(context.repo, parsed, url, api, context.dependencies)),
    () => {
      throw new ForgeRefusal("GitHub has no API that removes a pull request's uploaded file; only a Forgejo pull request's attachments can be detached.");
    },
  );
}

export async function renderMarkdown(context: ForgeContext, markdownFile: string): Promise<ProcessResult> {
  const text = await readFile(markdownFile, "utf8");
  return onRepositoryForge(
    context,
    async (api) => printedLine(await renderMarkdownOnForgejo(context.repo, text, api, context.dependencies)),
    (program) => github(context, program, githubRenderMarkdownArguments(text)),
  );
}
