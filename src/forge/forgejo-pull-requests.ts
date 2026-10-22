import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ForgeDependencies } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import type { ForgejoApi } from "./forgejo-api.ts";
import { forgejoTitle, isDraftTitle, titleNamingGithubTwin, titleWithoutDraftPrefix } from "./forgejo-pull-request-titles.ts";
import {
  forgejoRepositoryApiPath,
  forgejoRepositoryFor,
  pushBranchToForgejo,
  waitUntilForgejoRegistersBranch,
  type ForgejoRepository,
} from "./forgejo-repository.ts";
import type {
  AttachedFile,
  DetachedFile,
  NewPullRequest,
  OpenPullRequestSummary,
  PullRequestView,
} from "./pull-request-shapes.ts";
import { PULL_REQUEST_STATE } from "./pull-request-shapes.ts";
import type { PullRequestTarget, PullRequestUrlTarget } from "./pull-request-forge.ts";

export const FORGEJO_PAGE_LIMIT = 50;
const FORGEJO_OPEN_STATE = "open";
const FORGEJO_CLOSED_STATE = "closed";
const FORGEJO_MANUAL_MERGE_STYLE = "manually-merged";
const INLINE_VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov"]);

export interface ForgejoPullRequestRecord {
  readonly number: number;
  readonly html_url: string;
  readonly title: string;
  readonly body: string | null;
  readonly state: string;
  readonly merged: boolean;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string };
}

interface ForgejoAttachmentRecord {
  readonly id: number;
  readonly browser_download_url: string;
}

export interface ForgejoPullRequestAddress {
  readonly repository: ForgejoRepository;
  readonly number: number;
}

function githubStateOf(record: ForgejoPullRequestRecord): string {
  if (record.merged) return PULL_REQUEST_STATE.merged;
  return record.state === FORGEJO_OPEN_STATE ? PULL_REQUEST_STATE.open : PULL_REQUEST_STATE.closed;
}

function pullRequestViewOf(record: ForgejoPullRequestRecord): PullRequestView {
  return {
    number: record.number,
    url: record.html_url,
    title: titleWithoutDraftPrefix(record.title),
    body: record.body ?? "",
    state: githubStateOf(record),
    isDraft: isDraftTitle(record.title),
    headRefName: record.head.ref,
    baseRefName: record.base.ref,
  };
}

function pullsApiPath(repository: ForgejoRepository): string {
  return `${forgejoRepositoryApiPath(repository)}/pulls`;
}

export async function readOpenPullRequestRecords(
  repository: ForgejoRepository,
  limit: number,
  api: ForgejoApi,
): Promise<readonly ForgejoPullRequestRecord[]> {
  const records = await api.readJsonIfFound<ForgejoPullRequestRecord[]>(`${pullsApiPath(repository)}?state=open&limit=${limit}`);
  return records ?? [];
}

export function forgejoAddressOfUrl(target: PullRequestUrlTarget): ForgejoPullRequestAddress {
  return { repository: { owner: target.owner, name: target.repository }, number: target.number };
}

export async function findForgejoPullRequestAddress(
  repo: string,
  target: PullRequestTarget,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<ForgejoPullRequestAddress | undefined> {
  if (target.kind === "url") return forgejoAddressOfUrl(target);
  const repository = await forgejoRepositoryFor(repo, api, dependencies);
  if (target.kind === "number") return { repository, number: target.number };
  const open = await readOpenPullRequestRecords(repository, FORGEJO_PAGE_LIMIT, api);
  const match = open.find((record) => record.head.ref === target.text);
  return match === undefined ? undefined : { repository, number: match.number };
}

export async function forgejoPullRequestAddressOf(
  repo: string,
  target: PullRequestTarget,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<ForgejoPullRequestAddress> {
  const address = await findForgejoPullRequestAddress(repo, target, api, dependencies);
  if (address === undefined) throw new ForgeRefusal(`Forgejo has no open pull request from branch ${target.text} in this checkout's Forgejo copy.`);
  return address;
}

export function pullRequestApiPath(address: ForgejoPullRequestAddress): string {
  return `${pullsApiPath(address.repository)}/${address.number}`;
}

export function issueApiPath(address: ForgejoPullRequestAddress): string {
  return `${forgejoRepositoryApiPath(address.repository)}/issues/${address.number}`;
}

export async function createForgejoPullRequest(
  repo: string,
  request: NewPullRequest,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<PullRequestView> {
  const repository = await pushBranchToForgejo(repo, request.head, request.base, api, dependencies);
  const open = await readOpenPullRequestRecords(repository, FORGEJO_PAGE_LIMIT, api);
  const existing = open.find((record) => record.head.ref === request.head && record.base.ref === request.base);
  if (existing !== undefined) return pullRequestViewOf(existing);
  for (const branch of [request.base, request.head]) await waitUntilForgejoRegistersBranch(repository, branch, api);
  const created = await api.sendJson<ForgejoPullRequestRecord>("POST", pullsApiPath(repository), {
    title: titleNamingGithubTwin(forgejoTitle(request.title, request.draft), request.githubUrl),
    body: request.body,
    head: request.head,
    base: request.base,
  });
  return pullRequestViewOf(created);
}

export async function viewForgejoPullRequest(
  repo: string,
  target: PullRequestTarget,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<PullRequestView> {
  const address = await forgejoPullRequestAddressOf(repo, target, api, dependencies);
  return pullRequestViewOf(await api.readJson<ForgejoPullRequestRecord>(pullRequestApiPath(address)));
}

export async function readForgejoPullRequestIfFound(
  address: ForgejoPullRequestAddress,
  api: ForgejoApi,
): Promise<(PullRequestView & { readonly headSha: string }) | undefined> {
  const record = await api.readJsonIfFound<ForgejoPullRequestRecord>(pullRequestApiPath(address));
  return record === undefined ? undefined : { ...pullRequestViewOf(record), headSha: record.head.sha };
}

export async function editForgejoPullRequest(
  repo: string,
  target: PullRequestTarget,
  fields: { readonly title?: string; readonly body?: string },
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<PullRequestView> {
  const address = await forgejoPullRequestAddressOf(repo, target, api, dependencies);
  return pullRequestViewOf(await api.sendJson<ForgejoPullRequestRecord>("PATCH", pullRequestApiPath(address), fields));
}

export async function nameGithubTwinInForgejoTitle(address: ForgejoPullRequestAddress, githubUrl: string, api: ForgejoApi): Promise<void> {
  const record = await api.readJson<ForgejoPullRequestRecord>(pullRequestApiPath(address));
  const title = titleNamingGithubTwin(record.title, githubUrl);
  if (title !== record.title) await api.sendJson("PATCH", pullRequestApiPath(address), { title });
}

export async function listOpenForgejoPullRequests(
  repo: string,
  limit: number,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<OpenPullRequestSummary[]> {
  const repository = await forgejoRepositoryFor(repo, api, dependencies);
  const open = await readOpenPullRequestRecords(repository, limit, api);
  return Promise.all(
    open.map(async (record) => {
      const files = await api.readJson<Array<{ filename: string }>>(`${pullsApiPath(repository)}/${record.number}/files`);
      return {
        number: record.number,
        title: titleWithoutDraftPrefix(record.title),
        headRefName: record.head.ref,
        url: record.html_url,
        files: files.map((file) => ({ path: file.filename })),
      };
    }),
  );
}

export async function diffForgejoPullRequest(
  repo: string,
  target: PullRequestTarget,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<string> {
  const address = await forgejoPullRequestAddressOf(repo, target, api, dependencies);
  return api.readText(`${pullRequestApiPath(address)}.diff`);
}

export async function closeForgejoPullRequest(address: ForgejoPullRequestAddress, api: ForgejoApi): Promise<void> {
  await api.sendJson("PATCH", pullRequestApiPath(address), { state: FORGEJO_CLOSED_STATE });
}

export async function recordForgejoPullRequestAsMerged(address: ForgejoPullRequestAddress, commit: string, api: ForgejoApi): Promise<void> {
  await api.sendJson("PATCH", forgejoRepositoryApiPath(address.repository), { allow_manual_merge: true });
  await api.sendJson("POST", `${pullRequestApiPath(address)}/merge`, { Do: FORGEJO_MANUAL_MERGE_STYLE, MergeCommitID: commit });
}

export async function commentOnForgejoPullRequest(
  repo: string,
  target: PullRequestTarget,
  body: string,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<string> {
  const address = await forgejoPullRequestAddressOf(repo, target, api, dependencies);
  const comment = await api.sendJson<{ html_url: string }>("POST", `${issueApiPath(address)}/comments`, { body });
  return comment.html_url;
}

function escapeAttribute(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function markdownEmbeddingAttachment(fileName: string, url: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const name = path.basename(fileName, path.extname(fileName));
  return INLINE_VIDEO_EXTENSIONS.has(extension)
    ? `<video src="${escapeAttribute(url)}" title="${escapeAttribute(name)}" controls></video>`
    : `![${name}](${url})`;
}

export async function attachToForgejoPullRequest(
  repo: string,
  target: PullRequestTarget,
  filePath: string,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<AttachedFile> {
  const address = await forgejoPullRequestAddressOf(repo, target, api, dependencies);
  const fileName = path.basename(filePath);
  const attachment = await api.upload<{ browser_download_url: string }>(
    `${issueApiPath(address)}/assets?name=${encodeURIComponent(fileName)}`,
    { fieldName: "attachment", fileName, bytes: new Uint8Array(await readFile(filePath)) },
  );
  const url = attachment.browser_download_url;
  return { url, markdown: markdownEmbeddingAttachment(fileName, url) };
}

export async function detachFromForgejoPullRequest(
  repo: string,
  target: PullRequestTarget,
  url: string,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<DetachedFile> {
  const address = await forgejoPullRequestAddressOf(repo, target, api, dependencies);
  const attachments = await api.readJson<ForgejoAttachmentRecord[]>(`${issueApiPath(address)}/assets`);
  const attachment = attachments.find((candidate) => candidate.browser_download_url === url);
  if (attachment !== undefined) await api.remove(`${issueApiPath(address)}/assets/${attachment.id}`);
  return { detached: attachment !== undefined };
}

export async function renderMarkdownOnForgejo(
  repo: string,
  text: string,
  api: ForgejoApi,
  dependencies: ForgeDependencies,
): Promise<string> {
  const repository = await forgejoRepositoryFor(repo, api, dependencies);
  return api.sendJsonForText("POST", "markdown", {
    Mode: "gfm",
    Text: text,
    Context: `${repository.owner}/${repository.name}`,
  });
}
